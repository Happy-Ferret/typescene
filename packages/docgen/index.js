// Documentation generator that combines JSDoc from .d.ts files with markdown
// ===

// Default document title if none is specified in markdown files:
const DEFAULT_DOC_TITLE = "Documentation";

// main function is exported as generateAsync(...folders)
module.exports = { generateAsync };

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Main

"use strict";
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const md = require("markdown-it")({
    html: true,
    typographer: true
});

// helper functions:
const flatten = array => array.reduce((r, a) =>
    r.concat((a instanceof Array) ? flatten(a) : a),
    []);
const getSortIdForItem = (item) => {
    var result = item.id.replace(/^(.*[^\w_])?([\w_]+)$/, "$2");
    if (item.textSort) result = item.textSort;
    else if (item.isStatic) result = " " + result; // on top
    else if (item.isCtor) result = "___"; // after static props
    else if (item.isProtected) result = "| "; // down
    else if (item.isDecorator) result = "|~" + result; // down
    else if (item.isSignal) result = "~" + result; // bottom
    if (item.isType || item.isEnum) result = "\\" + result;
    return result;
}
const byIdSorter = (a, b) => {
    var a_id = getSortIdForItem(a);
    var b_id = getSortIdForItem(b);
    if (a_id === b_id) return a.sourceIdx - b.sourceIdx;
    return a_id > b_id ? 1 : -1;
}

// main function:
function generateAsync(/* ...sourceDirs: string[] */) {
    /** List of of all declaration items by ID */
    const declItems = {};

    /** List of of all text items by ID */
    const textItems = {};

    /** List of all items, merged after parsing both declarations and text */
    const allItems = {};

    // scan source directories
    var sourceDirs = [];
    for (var s of arguments) sourceDirs.push(s);
    return Promise.all(sourceDirs.map(recurseDir))
        .then(itemLists => flatten(itemLists)
            .map((item, i) => ((item.sourceIdx = i), item))  // mark position
            .sort(byIdSorter)  // sort by ID and then position
            .map(item => {
                // merge text and declaration items
                var declItem = declItems[item.id];
                if (!declItem || declItem === item) {
                    // this is the main item, keep it in the list
                    allItems[item.id] = item;
                    return item;
                }
                else {
                    // merge texts and properties for this item
                    if (declItem.text && item.text)
                        declItem.text = declItem.text.concat(item.text);
                    for (var prop in item)
                        declItem[prop] = declItem[prop] || item[prop];
                }
            })
            .filter(item => !!item))
        .then(result => {
            populateInheritance();
            var toc = makeTOC(result);
            var title = findDocTitle(toc) || DEFAULT_DOC_TITLE;
            return JSON.stringify({ title, toc, items: result });
        });


    // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

    /** Helper function that parses files recursively, and returns a promise for lists (of lists...) of items */
    function recurseDir(pathName) {
        if (pathName.slice(-1) === "/") pathName = pathName.slice(0, -1);
        return new Promise((resolve, reject) => {
            fs.readdir(pathName, (err, list) => {
                if (err) return reject(err);

                // make a promise for each file, and wait for all together
                resolve(Promise.all(list.sort().map(fileName => {
                    fileName = pathName + "/" + fileName;
                    return new Promise((resolve, reject) => {
                        fs.stat(fileName, (err, stat) => {
                            if (err) return reject(err);

                            // process file/directory recursively
                            if (stat.isDirectory()) {
                                // recurse into directory
                                resolve(recurseDir(fileName));
                            }
                            else if (fileName.endsWith(".d.ts")) {
                                // process declaration file
                                resolve(processDeclarationFile(fileName));
                            }
                            else if (fileName.endsWith(".ref.md")) {
                                // process text file
                                resolve(processTextFile(fileName));
                            }
                            else {
                                // this is some other file... do nothing
                                resolve([]);
                            }
                        });
                    });
                })));
            });
        });
    }

    /** Helper function to make a root table of contents for given (sorted) items */
    function makeTOC(items) {
        // add reference index if none defined yet
        if (!allItems["~reference"]) {
            var refItem = {
                id: "~reference",
                name: "Reference",
                textSlug: "reference",
                text: []
            };
            allItems["~reference"] = refItem;
            items.push(refItem);
        }

        // helper to sort all sub items by ID (or textSort property)
        function sortSubItems(item) {
            if (item.items) {
                item.items = item.items.sort(byIdSorter);
                item.items.forEach(sortSubItems);
            }
        }

        // list all items under their TOC parents
        items.forEach(item => {
            // find TOC parent, or use ~reference for code items
            var parentID = item.textParent;
            if (!parentID) {
                if (item.code) parentID = "~reference";
                else {
                    var match = item.id.match(/(.*)\/[^\/]+$/);
                    if (match && allItems[match[1]])
                        item.textParent = parentID = match[1];
                }
            }
            var parent = allItems[parentID];

            // add item to TOC list
            if (parent) {
                if (!parent.toc) parent.toc = [];
                parent.toc.push(item.id);
            }

            // sort sub items
            sortSubItems(item);
        });

        // find root items (i.e. has children OR no code, but no parent)
        return items.filter(item => (!item.textParent && (!item.code || item.toc)))
            .map(item => item.id);
    }

    /** Helper function to make a root table of contents for given (sorted) items */
    function findDocTitle(toc) {
        for (var i = 0; i < toc.length; i++) {
            var item = allItems[toc[i]];
            if (item.textDocTitle)
                return item.textDocTitle;
            if (item.toc) {
                var result = findDocTitle(item.toc);
                if (result) return result;
            }
        }
    }

    /** Helper function to find inherited (static/property) members for all items */
    function populateInheritance() {
        for (var id in declItems) {
            var item = declItems[id];
            if (!item.extends || !item.items) continue;

            // track static inheritance, instance inheritance, and constructors
            var staticInh = [], instanceInh = [], ctorInh = [];

            // find all overridden items first (use name, not ID)
            var seen = {}, hasCtor = false;
            item.items.forEach(sub => {
                seen[(sub.isStatic ? "static~" : "") + sub.name] = true;
                if (sub.isCtor) hasCtor = true;
            });

            // recurse bottom-up for all derived classes
            function recurseFindInherits(ids) {
                ids && ids.forEach(id => {
                    if (!declItems[id]) return;
                    var sup = declItems[id];

                    // find inherited constructor(s) from this class
                    if (!hasCtor && !ctorInh.length) {
                        sup.items.forEach(sub => {
                            if (sub.isCtor) ctorInh.push(sub.id);
                        });
                    }

                    // add inherited static methods (not members!), and inherited
                    // all non-static items from this class
                    sup.items.forEach(inhItem => {
                        if (inhItem.isStatic && inhItem.isMethod &&
                            !seen["static~" + inhItem.name]) {
                            staticInh.push(inhItem.id);
                            seen["static~" + inhItem.name] = true;
                        }
                        else if (!inhItem.isStatic && !inhItem.isCtor &&
                            !seen[inhItem.name]) {
                            instanceInh.push(inhItem.id);
                            seen[inhItem.name] = true;
                        }
                    });

                    // recurse bottom-up
                    recurseFindInherits(sup.extends);
                });
            }
            recurseFindInherits(item.extends);

            // merge everything together
            var inherited = [].concat(staticInh, ctorInh, instanceInh);
            if (inherited.length) {
                item.inherits = inherited.sort((a, b) =>
                    byIdSorter(declItems[a], declItems[b]));
            }
        }
    }


    // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // Text file parser (*.ref.md)

    function processTextFile(fileName) {
        return new Promise((resolve, reject) => {
            fs.readFile(fileName, (err, buf) => {
                if (err) return reject(err);

                // split this file on level 1 headings
                var str = String(buf);
                var chapters = str.split(/(?:\n|^)#\s*(?!#)/).slice(1);

                // create an item for each chapter
                var items = chapters.map(part => {
                    var lines = part.split(/\r\n|\n\r|\r|\n/);
                    var item = {};

                    // determine name and ID from heading (or comments below)
                    item.id = (item.name = lines.shift().trim())
                        .replace(/\s+/g, "-");

                    // split into running named sections
                    var sections = [], section;
                    lines.forEach(l => {
                        var commentMatch = (!section || !section.lines.length) &&
                            l.match(/^\s*<!--\s*([\w_]+):(.*)-->\s*$/);
                        if (commentMatch) {
                            // found a tag comment
                            var tag = commentMatch[1];
                            var content = commentMatch[2].trim();
                            if (!section) {
                                // top level tag: check for "ID",
                                // otherwise add to item as "text*"
                                if (tag.toLowerCase() === "id")
                                    item.id = content;
                                else
                                    item["text" + tag.charAt(0).toUpperCase() +
                                        tag.slice(1)] = content;
                            }
                            else {
                                // section-level tag: add to section object
                                section[tag] = content;
                            }
                        }
                        else if (l.charAt(0) === "#") {
                            // start a new section with this heading
                            section = {
                                title: l.replace(/^#+\s*/, ""),
                                lines: []
                            };
                            sections.push(section);
                        }
                        else if (/\S/.test(l) || section) {
                            // add this line to current section
                            if (!section) {
                                // intialize a section without a title
                                section = { title: "", lines: [] };
                                sections.push(section);
                            }
                            section.lines.push(l);
                        }
                    });

                    // concatenate lines and parse markdown
                    item.text = sections;
                    sections.forEach(section => {
                        section.content = md.render(section.lines.join("\n"));
                        delete section.lines;
                    })

                    // add item to global list and return it
                    textItems[item.id] = item;
                    return item;
                });
                resolve(items);
            });
        });
    }


    // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // Declaration file parser (*.d.ts)

    function processDeclarationFile(fileName) {
        return new Promise((resolve, reject) => {
            fs.readFile(fileName, (err, buf) => {
                if (err) return reject(err);

                // parse file using the TypeScript compiler
                var sourceFile = ts.createSourceFile(fileName, String(buf),
                    ts.ScriptTarget.ES5, true);

                // helper function to convert JSDoc documentation to HTML
                var lastJSDocComment = null;
                function getJSDocHtml(node) {
                    var comment = "No description";
                    var firstChild = node.getChildCount() > 1 ?
                        node.getChildAt(0) : null;
                    if (firstChild && firstChild.comment)
                        comment = String(firstChild.comment).trim();
                    else if (lastJSDocComment)
                        comment = String(lastJSDocComment.comment).trim();
                    if (!comment.endsWith(".") && comment.split(" ").length > 2)
                        comment += ".";
                    var html = md.render(comment.replace(/\n(?!\*)/g, "  \n"));
                    lastJSDocComment = null
                    return html;
                }

                // helper function to check for given modifier keyword
                function hasModifier(node, keywordID) {
                    return (node.modifiers && node.modifiers.some(mod =>
                        mod.kind === keywordID));
                }

                // helper function to get the code for a class-like node
                function getClassCode(node) {
                    return node.name.getText() +
                        (node.typeParameters ? "<" +
                            node.typeParameters.map(p => p.getText())
                                .join(", ") + ">" :
                            "") +
                        (node.heritageClauses ?
                            node.heritageClauses.map(h => " " + h.getText())
                                .join("") :
                            "");
                }

                // recursive function to parse declarations, returns a list of items
                function getChildItems(parentNode, parent) {
                    var items = [];
                    ts.forEachChild(parentNode, child => {
                        var item, code;
                        var name = ((child.name && child.name.getText) ?
                            child.name.getText() : child.name) ||
                            "<undefined>";
                        var idParts = (parent && parent.id) ?
                            [parent.id, name] : [name];
                        var id = idParts.join(".");
                        switch (child.kind) {
                            case ts.SyntaxKind.ModuleDeclaration:
                                // create namespace item (unless already known)
                                item = { id, name, isNamespace: true };
                                code = "namespace " + name;
                                break;
                            case ts.SyntaxKind.ClassDeclaration:
                                // create class item
                                item = { id, name, isClass: true };
                                code = "class " + getClassCode(child);
                                break;
                            case ts.SyntaxKind.InterfaceDeclaration:
                                // create interface item
                                item = { id, name, isInterface: true };
                                code = "interface " + getClassCode(child);
                                break;
                            case ts.SyntaxKind.Constructor:
                            case ts.SyntaxKind.MethodDeclaration:
                            case ts.SyntaxKind.FunctionDeclaration:
                            case ts.SyntaxKind.ConstructSignature:
                            case ts.SyntaxKind.MethodSignature:
                            case ts.SyntaxKind.CallSignature:
                                // determine if this item is static
                                var staticMethod = !!(parent && parent.isNamespace ||
                                    hasModifier(child, ts.SyntaxKind.StaticKeyword));

                                // create function/method item
                                id = idParts.join(staticMethod ? "." : "/");
                                var hasParams = !!(child.parameters &&
                                    child.parameters.length);
                                item = { id, name, hasParams };
                                if (staticMethod) item.isStatic = true;
                                if (parent) item.isMethod = true;
                                else item.isFunction = true;

                                // use "new ..." for constructor names
                                if ((child.kind === ts.SyntaxKind.Constructor ||
                                    child.kind === ts.SyntaxKind.ConstructSignature) &&
                                    parent) {
                                    item.isCtor = true;
                                    delete item.isMethod;
                                    item.name = name = (child.kind === ts.SyntaxKind.Constructor) ?
                                        "new " + parent.name : "new";
                                    item.id = idParts[0] + ".constructor";
                                }

                                // use "<call>" for call signature names
                                if (child.kind === ts.SyntaxKind.CallSignature &&
                                    parent) {
                                    item.name = name = "<call>";
                                    item.id = idParts[0] + ".!call";
                                }
                                break;
                            case ts.SyntaxKind.VariableDeclaration:
                            case ts.SyntaxKind.PropertyDeclaration:
                            case ts.SyntaxKind.PropertySignature:
                            case ts.SyntaxKind.IndexSignature:
                                // determine if this item is static
                                var staticProp = !!(parent && parent.isNamespace ||
                                    hasModifier(child, ts.SyntaxKind.StaticKeyword));

                                // create variable/property item
                                id = idParts.join(staticProp ? "." : "/");
                                item = { id, name };
                                if (staticProp) item.isStatic = true;
                                if (parent) item.isProperty = true;
                                else item.isVar = true;

                                // determine readonly/const modifier
                                if (hasModifier(child, ts.SyntaxKind.ReadonlyKeyword))
                                    item.isReadOnly = true;
                                if (hasModifier(child, ts.SyntaxKind.ConstKeyword))
                                    item.isConst = true;

                                // use "[type]" for index signatures
                                if (child.kind === ts.SyntaxKind.IndexSignature) {
                                    let match = child.getText().match(
                                        /\[[^:]+\:\s*([^\]\s]+)\]/);
                                    var indexType = (match && match[1]) || "any";
                                    item.name = name = "[" + indexType + "]";
                                    item.id = idParts[0] + ".!index:" + indexType;
                                }
                                break;
                            case ts.SyntaxKind.TypeAliasDeclaration:
                                // create type item
                                item = { id, name, isType: true };
                                break;
                            case ts.SyntaxKind.EnumDeclaration:
                                // create enum item
                                item = { id, name, isEnum: true };
                                code = "enum " + name;
                                break;
                            case ts.SyntaxKind.EnumMember:
                                // create enum member (const) item
                                item = { id, name, isStatic: true, isConst: true };
                                code = "enum " + parent.name +
                                    " { ..." + name + " }";
                                break;
                            default:
                                // recurse if anything else
                                var swallowedJSDoc = null;
                                if (child.jsDoc && child.jsDoc.length) {
                                    // remember (undocumented) JSDoc if it was
                                    // swallowed by the compiler in a parent node
                                    swallowedJSDoc = lastJSDocComment =
                                        child.jsDoc[0];
                                }
                                getChildItems(child, parent)
                                    .forEach(z => items.push(z));

                                // on the way out, reset JSDoc comment
                                if (swallowedJSDoc === lastJSDocComment)
                                    lastJSDocComment = null;
                                return;
                        }

                        // add common properties, read JSDoc comment
                        item.file = fileName;
                        item.line = ts.getLineAndCharacterOfPosition(
                            sourceFile, child.getStart()).line;
                        item.code = code || child.getText()
                            .replace(/^(?:\s*(?:export|declare|public)\s+)+/, "")
                            .replace(/\s+/g, " ");
                        var doc = item.doc = getJSDocHtml(child);

                        // mark protected items, skip private items
                        if (hasModifier(child, ts.SyntaxKind.ProtectedKeyword))
                            item.isProtected = true;
                        if ((/\@internal|\[implementation\]/i.test(doc)) ||
                            (name || "").charAt(0) === "_" ||
                            (child.modifiers && child.modifiers.some(mod =>
                                mod.getText() === "private")))
                            return;

                        // everything in a namespace is static
                        if (parent && parent.isNamespace) item.isStatic = true;

                        // add "extends" clauses (leave out type parameters)
                        if (child.heritageClauses) {
                            var names = child.heritageClauses
                                .map(clause => clause.getText().replace(/\<.*/, ""))
                                .filter(s => s.startsWith("extends"))
                                .map(s => s.replace(/^extends\s*/, ""));
                            if (names.length)
                                item.extends = names;
                        }

                        // add type parameters and type
                        if (child.typeParameters && child.typeParameters.length)
                            item.typeParams = child.typeParameters.map(t => t.getText());
                        if (child.type && child.type.getText) {
                            var type = child.type.getText();
                            if (type !== "any") item.declType = type;
                            if (!item.isMethod && !item.isFunction &&
                                /^[\w_\.]*Signal\.Emittable/.test(type))
                                item.isSignal = true;
                            if (/^(I)?Promise(Like|_Thenable)?\</.test(type))
                                item.isAsync = true;
                        }
                        if (item.isFunction && /\[decorator\]/.test(doc))
                            item.isDecorator = true;

                        // merge with existing item, if any
                        var existing = declItems[item.id];
                        if (existing) {
                            // enumerate declarations for same IDs
                            if (!item.isNamespace) {
                                existing.code += "\n" + item.code;
                                if (existing.doc !== item.doc) {
                                    if (!existing.count) {
                                        existing.count = 1;
                                        existing.doc = existing.doc
                                            .replace(/\>/, ">[1]. ");
                                    }
                                    var n = ++existing.count;
                                    item.doc = item.doc
                                        .replace(/\>/, ">[" + n + "]. ");
                                    existing.doc += item.doc;
                                }
                                if (existing.declType && item.declType) {
                                    existing.declType += " | " + item.declType;
                                }
                            }

                            // copy `isNamespace` onto class item as well
                            // (to mark members as static in this context)
                            if (item.isNamespace) existing.isNamespace = true;

                            // use existing instance for recursion below
                            item = existing;
                        }
                        else {
                            // no existing item, add to list of items
                            declItems[item.id] = item;
                            items.push(item);
                        }

                        // recurse for items containing sub items
                        if (item.isClass || item.isInterface ||
                            item.isNamespace || item.isEnum) {
                            if (!item.items) item.items = [];
                            getChildItems(child, item).forEach(z => item.items.push(z));
                        }
                    });
                    return items;
                }

                // do this for all declarations recursively
                resolve(getChildItems(sourceFile, null));
            });
        });
    }
}
