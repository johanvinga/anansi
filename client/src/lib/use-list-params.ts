import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

interface MutateOptions {
  /** Adds a history entry instead of replacing the current one. */
  push?: boolean;
}

/**
 * List filter state (search, tags, page, ...) stored in the URL query string so list pages are
 * linkable and survive reloads. With `persist` false the same API is backed by local state,
 * for lists embedded in another page whose URL must stay untouched.
 */
export function useListParams(persist = true) {
  const [urlParams, setUrlParams] = useSearchParams();
  const [localParams, setLocalParams] = useState(() => new URLSearchParams());
  const params = persist ? urlParams : localParams;
  // Several setters can run in one event; each must build on the previous result, not the stale render.
  const latest = useRef(params);
  latest.current = params;

  function mutate(change: (next: URLSearchParams) => void, options: MutateOptions = {}) {
    const next = new URLSearchParams(latest.current);
    change(next);
    latest.current = next;
    if (persist) setUrlParams(next, { replace: !options.push });
    else setLocalParams(next);
  }

  return {
    getString: (key: string) => params.get(key) ?? "",
    getAll: (key: string) => params.getAll(key),
    setString: (key: string, value: string | null, options?: MutateOptions) =>
      mutate((next) => {
        if (value) next.set(key, value);
        else next.delete(key);
      }, options),
    setAll: (key: string, values: string[], options?: MutateOptions) =>
      mutate((next) => {
        next.delete(key);
        for (const value of values) next.append(key, value);
      }, options),
    /** Applies several single-value changes in one URL update; `null` removes the key. */
    setMany: (changes: Record<string, string | null>, options?: MutateOptions) =>
      mutate((next) => {
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
      }, options),
  };
}

export type ListParams = ReturnType<typeof useListParams>;
