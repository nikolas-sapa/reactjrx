# useObserve

The `useObserve` hook subscribes to an observable once the component has mounted, and returns its latest value, along with whether it has one and the state of the stream.

```typescript
useObserve(source, optionsOrDeps?, deps?)
```

## Reference

```typescript
function App () {
    const { data: user, status } = useObserve(user$)

    if (status === "error") return <ErrorMessage />
    if (status === "pending") return <Spinner />

    return <div>current user: { user.name }</div>
}
```

***

```typescript
function useObserve<T, DefaultValue>(
  source: Observable<T> | (() => Observable<T> | undefined) | undefined,
  optionsOrDeps?: Options<T, DefaultValue> | DependencyList,
  deps?: DependencyList
):
  | { status: "pending"; data: DefaultValue; error: undefined; observableState: "live" | "complete" }
  | { status: "success"; data: T; error: undefined; observableState: "live" | "complete" }
  | { status: "error"; data: T | DefaultValue; error: unknown; observableState: "error" }
```

```typescript
interface Options<T, DefaultValue> {
  defaultValue?: DefaultValue
  compareFn?: (a: T, b: T) => boolean
}
```

### Parameters

* `source`: An observable, a function returning one, or `undefined`. Pass a stable observable directly: the hook subscribes to it again when its reference changes. Otherwise pass a function with `deps`, so the observable is only created again when a dependency changes. With `undefined`, nothing is observed and the default value is returned.
* **optional** `options`:
  * `defaultValue`: returned as `data` while the source has no value. A `BehaviorSubject`, or a signal, has its value on the first render and doesn't need it.
  * `compareFn`: tells whether a new value equals the previous one. An equal value doesn't re-render. Defaults to strict equality (`===`). Pass `isShallowEqual` (exported by reactjrx), or your own function, to compare objects by content.
* **optional** `deps`: The values the function depends on. When one of them changes (compared with [`Object.is`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/is)), the function is called again and its observable replaces the previous one.

### Returns

An object with:

* `status`: whether the source has a value, as the queries of TanStack Query report theirs.
  * `"pending"`: no value yet. `data` is `defaultValue` (`undefined` otherwise).
  * `"success"`: the source has a value. `data` is its latest value, typed as one.
  * `"error"`: the source errored. `data` keeps its last value, or `defaultValue` if it had none.
* `data`: the latest value, or `defaultValue`. Its type follows `status`.
* `observableState`: the life of the stream: `"live"` while it can still emit, `"complete"` once it completed (or without a source), `"error"` once it errored.
* `error`: the error the source failed with, when `status` is `"error"`.

### **Caveats**&#x20;

* The hook subscribes after React commits the render, in a layout effect, never during render. A render that React throws away (a Suspense boundary that suspends, an error boundary, an abandoned transition) and a server render subscribe to nothing.
* On the first render, only a source that holds a value has it: a `BehaviorSubject`, or a signal. Any other source is `"pending"`.
* A source that emits as soon as it is subscribed (`of(x)`, a piped signal, a `ReplaySubject` holding a value) replaces the pending state before the browser paints. The user doesn't see it, but the component renders twice. A source that emits later stays `"pending"` until it does.
* An observable created during render, such as `source$.pipe(...)` written in the component, is a new observable on every render. The hook subscribes to it again after each render, and one that emits on subscription renders the component again without end. Create it in a function with `deps`.
* A new value that `compareFn` considers equal to the previous one doesn't re-render. By default that's strict equality, so a new object with the same content does re-render.
* An error doesn't throw: the hook returns `status: "error"` with the `error`, keeps the last `data`, and doesn't report the error as unhandled.
* Once the source has completed or errored, the hook doesn't subscribe to it again, also when React runs its effects again (`StrictMode` in development, an `<Activity>` shown again). Pass a new source, or change `deps`, to start over.

## Usages

#### Displaying a timer

Here we display an infinite timer which starts at `0`. The timer can't emit before the browser paints, so `defaultValue` provides a value until it does. The `map` makes `1` the first value the source emits.

```typescript
function App () {
    const { data: currentTime } = useObserve(
      () => interval(1000).pipe(map((value) => value + 1)),
      { defaultValue: 0 },
      []
    )

    return <div>{ currentTime }</div>
}
```

#### Subscribing to an external subject

A `BehaviorSubject` always holds a value, so it's there on the first render, and `status` is `"success"`.

```typescript
const clickedSubject = new BehaviorSubject(0)

function App () {
    const { data: clicked } = useObserve(clickedSubject)

    return (
        <div>
            <div>User clicked { clicked } times</div>
            <button onClick={() => clickedSubject.next(clicked + 1)}>click me!</button>
        </div>
    )
}
```

Any other source, such as a `ReplaySubject` that already holds a value, is `"pending"` on the first render, then has its value before the browser paints. Check `status`, and `data` is typed as a value:

```typescript
const clickedSubject = new ReplaySubject<number>(1)

function App () {
    const { data: clicked, status } = useObserve(clickedSubject)

    if (status !== "success") return null

    return (
        <div>
            <div>User clicked { clicked } times</div>
            <button onClick={() => clickedSubject.next(clicked + 1)}>click me!</button>
        </div>
    )
}
```

#### Selecting part of a value

There is no selector option: map the source to the part you need, and skip values whose selected part didn't change with `distinctUntilChanged`. For a signal, `useSignalValue(signal, selector)` reads the selected part on the first render instead.

```typescript
const value$ = new BehaviorSubject({ foo: "bar", bar: "foo" })

// in your component
const { data: foo } = useObserve(
  () =>
    value$.pipe(
      map(({ foo }) => foo),
      distinctUntilChanged()
    ),
  []
)
```
