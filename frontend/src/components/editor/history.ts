import { useCallback, useReducer } from "react";

/** JSONB may reorder object keys; arrays and every value remain engineering state. */
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export type EditHistory<T> = { value: T; past: T[]; future: T[] };
export type EditAction<T> = { type: "edit"; value: T } | { type: "load"; value: T } | { type: "undo" } | { type: "redo" };
export function editHistory<T>(state: EditHistory<T>, action: EditAction<T>): EditHistory<T> {
  if (action.type === "load") return { value: action.value, past: [], future: [] };
  if (action.type === "edit") return canonicalJson(action.value) === canonicalJson(state.value) ? state : { value: action.value, past: [...state.past.slice(-99), state.value], future: [] };
  if (action.type === "undo") return state.past.length ? { value: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.value, ...state.future] } : state;
  return state.future.length ? { value: state.future[0]!, past: [...state.past, state.value], future: state.future.slice(1) } : state;
}
export function useEditHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(editHistory<T>, { value: initial, past: [], future: [] });
  const edit = useCallback((value: T) => dispatch({ type: "edit", value }), []);
  const load = useCallback((value: T) => dispatch({ type: "load", value }), []);
  return { ...state, edit, load, undo: () => dispatch({ type: "undo" }), redo: () => dispatch({ type: "redo" }) };
}
