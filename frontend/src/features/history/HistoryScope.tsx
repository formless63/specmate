import { createContext, useContext } from 'react';

/** Cache/navigation identity only. Every history read obtains current server authority. */
type HistoryIdentity = { workspaceId: string; principalKey: string };
const HistoryScope = createContext<HistoryIdentity | null>(null);
export const HistoryScopeProvider = HistoryScope.Provider;
export const useHistoryIdentity = () => useContext(HistoryScope);
