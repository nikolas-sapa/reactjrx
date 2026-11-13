import {
  type DependencyList,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { BehaviorSubject, type Observable } from "rxjs"
import { useLiveRef } from "../../utils/react/useLiveRef"
import type { ObservableState, UseObserveResult } from "./types"

export type {
  ObservableState,
  UseObserveOptions,
  UseObserveResult,
} from "./types"

interface Option<T, R = undefined> {
  defaultValue: R
  compareFn?: (a: T, b: T) => boolean
}

type SourceState<T> = {
  source: Observable<T> | undefined
  observableState: ObservableState
  error: unknown
} & ({ hasValue: false } | { hasValue: true; value: T })

/**
 * The state of `source` before React subscribes to it. Rendering reads only
 * what the source already holds, the value of a `BehaviorSubject` (a signal
 * is one), and subscribes to nothing.
 */
const getInitialState = <T>(
  source: Observable<T> | undefined,
): SourceState<T> => {
  const state = { source, error: undefined }

  if (source === undefined) {
    return { ...state, observableState: "complete", hasValue: false }
  }

  if (source instanceof BehaviorSubject) {
    try {
      return {
        ...state,
        observableState: "live",
        hasValue: true,
        value: source.getValue(),
      }
    } catch {
      // An errored or closed subject reports its error once subscribed.
    }
  }

  return { ...state, observableState: "live", hasValue: false }
}

const isStrictlyEqual = (a: unknown, b: unknown) => a === b

const toResult = <T, DefaultValue>(
  state: SourceState<T>,
  defaultValue: DefaultValue,
): UseObserveResult<T, DefaultValue> => {
  if (state.observableState === "error") {
    return {
      status: "error",
      data: state.hasValue ? state.value : defaultValue,
      error: state.error,
      observableState: "error",
    }
  }

  if (state.hasValue) {
    return {
      status: "success",
      data: state.value,
      error: undefined,
      observableState: state.observableState,
    }
  }

  return {
    status: "pending",
    data: defaultValue,
    error: undefined,
    observableState: state.observableState,
  }
}

/**
 * The source can be `undefined` (directly or returned from a factory). This is
 * useful when the observable is not available yet (lazily created, coming from
 * a state, a prop, etc). In that case the hook returns the default value with a
 * `complete` observable state and will start observing as soon as an actual
 * source is given.
 */
export function useObserve(
  source: undefined,
): UseObserveResult<never, undefined>

export function useObserve<DefaultValue>(
  source: undefined,
  options: Option<unknown, DefaultValue>,
): UseObserveResult<never, DefaultValue>

export function useObserve<T>(
  source: BehaviorSubject<T>,
): UseObserveResult<T, T>

export function useObserve<T>(
  source: BehaviorSubject<T>,
  options: Omit<Option<T>, "defaultValue">,
): UseObserveResult<T, T>

export function useObserve<T>(
  source: Observable<T> | undefined,
): UseObserveResult<T, undefined>

export function useObserve<T>(
  source: () => Observable<T>,
  deps: DependencyList,
): UseObserveResult<T, undefined>

export function useObserve<T>(
  source: () => Observable<T> | undefined,
  deps: DependencyList,
): UseObserveResult<T, undefined>

export function useObserve<T, DefaultValue>(
  source: Observable<T> | undefined,
  options: Option<T, DefaultValue>,
): UseObserveResult<T, DefaultValue>

export function useObserve<T>(
  source: Observable<T> | undefined,
  options: Omit<Option<T>, "defaultValue">,
): UseObserveResult<T, undefined>

export function useObserve<T, DefaultValue>(
  source: () => Observable<T>,
  options: Option<T, DefaultValue>,
  deps: DependencyList,
): UseObserveResult<T, DefaultValue>

export function useObserve<T, DefaultValue>(
  source: () => Observable<T> | undefined,
  options: Option<T, DefaultValue>,
  deps: DependencyList,
): UseObserveResult<T, DefaultValue>

export function useObserve<T, DefaultValue = T>(
  source$: Observable<T> | undefined | (() => Observable<T> | undefined),
  optionsOrDeps?: Partial<Option<T, DefaultValue>> | DependencyList,
  maybeDeps?: DependencyList,
): UseObserveResult<T, DefaultValue | undefined> {
  const options =
    optionsOrDeps != null && !Array.isArray(optionsOrDeps)
      ? (optionsOrDeps as Partial<Option<T, DefaultValue>>)
      : ({
          defaultValue: undefined,
          compareFn: undefined,
        } satisfies Partial<Option<T, DefaultValue>>)
  const deps =
    !maybeDeps && Array.isArray(optionsOrDeps)
      ? optionsOrDeps
      : typeof source$ === "function"
        ? (maybeDeps ?? [])
        : [source$]

  /**
   * The caller's deps decide when the factory runs again, compared with
   * `Object.is`. A source created during render without a factory is a new
   * source on every render.
   */
  const source = useMemo(
    () => (typeof source$ === "function" ? source$() : source$),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps decide when the factory runs again
    deps,
  )
  const [state, setState] = useState(() => getInitialState(source))
  const initialState = useMemo(() => getInitialState(source), [source])
  const current = state.source === source ? state : initialState
  const currentRef = useLiveRef(current)
  const compareFnRef = useLiveRef(options.compareFn)
  /**
   * The source that completed or errored. It won't emit again, so it is not
   * subscribed again when React runs the effect again: in development under
   * `StrictMode`, or when an `<Activity>` shows the component again.
   */
  const endedSourceRef = useRef<Observable<T> | undefined>(undefined)

  /**
   * The source is subscribed after commit only, so a render that React throws
   * away, and a server render, start nothing. A layout effect, so a value the
   * source emits on subscription replaces the pending state before the
   * browser paints.
   */
  useLayoutEffect(
    function observeSource() {
      if (!source || endedSourceRef.current === source) return

      /**
       * The state of the source as the committed render shows it, then as
       * this subscription last set it. Only this subscription changes the
       * state of its source, so a value that changes nothing, such as the one
       * a `BehaviorSubject` emits on subscription, sets no state and renders
       * nothing.
       */
      let latest = currentRef.current

      const commit = (next: SourceState<T>) => {
        latest = next
        setState(next)
      }

      const subscription = source.subscribe({
        next: (value) => {
          const isEqual = compareFnRef.current ?? isStrictlyEqual

          if (latest.hasValue && isEqual(latest.value, value)) return

          commit({
            source,
            observableState: latest.observableState,
            error: latest.error,
            hasValue: true,
            value,
          })
        },
        // Handled here, the error is not reported to RxJS as unhandled.
        error: (error: unknown) => {
          endedSourceRef.current = source
          commit({ ...latest, observableState: "error", error })
        },
        complete: () => {
          endedSourceRef.current = source
          commit({ ...latest, observableState: "complete" })
        },
      })

      return () => {
        subscription.unsubscribe()
      }
    },
    [source, currentRef, compareFnRef],
  )

  const { defaultValue } = options

  return useMemo(() => toResult(current, defaultValue), [current, defaultValue])
}
