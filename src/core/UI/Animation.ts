import Async from "../Async";
import { Component, Style } from "./";

/** Current unique ID, appended to name */
var _uid = 0;

/** Current status: all enabled or disabled */
var _enabled = true;

/** Represents a UI component animation */
export abstract class Animation {
    public static enableAll() { _enabled = true }
    public static disableAll() { _enabled = false }
    public static get isEnabled() { return _enabled }

    constructor(name: string) {
        this.name = name;
        this.id = String(name).replace(/\W/g, "_") + "__" + _uid++;
    }

    /** Unique ID (includes name and a unique number, generated by constructor) */
    public readonly id: string;

    /** Name of the animation (not necessarily unique) */
    public readonly name: string;

    /** Total duration in milliseconds of (the looping segment of) this animation, set by implementation */
    public duration = 0;

    /** Play the animation on given component */
    public abstract play(component: Component): Animation.AnimationControl<Animation>;

    /** Play the animation once for the entire duration, and then stop it */
    public playOnce(component: Component): Animation.AnimationControl<Animation> {
        var anim = this.play(component);
        anim.done.then(() => anim.stop());
        return anim;
    }
}
export namespace Animation {
    /** Represents the public interface for a playing animation */
    export interface AnimationControl<AnimationT extends Animation> {
        /** Reference to the animation itself */
        animation: AnimationT;
        /** Stop playing the animation, clear its artifacts */
        stop(): void;
        /** Promise that resolves to the animation control itself, after the animation is over (duration has passed) */
        done: PromiseLike<AnimationControl<AnimationT>>;
    }
}
