import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewMode = 'grid' | 'list' | 'rows';

interface ViewPrefsState {
  shelfViewMode: ViewMode;
  libraryViewMode: ViewMode;
  searchViewMode: ViewMode;
  setShelfViewMode: (v: ViewMode) => void;
  setLibraryViewMode: (v: ViewMode) => void;
  setSearchViewMode: (v: ViewMode) => void;
}

export const useViewPrefsStore = create<ViewPrefsState>()(
  persist(
    (set) => ({
      shelfViewMode: 'grid',
      libraryViewMode: 'grid',
      searchViewMode: 'grid',
      setShelfViewMode: (v) => set({ shelfViewMode: v }),
      setLibraryViewMode: (v) => set({ libraryViewMode: v }),
      setSearchViewMode: (v) => set({ searchViewMode: v }),
    }),
    { name: 'moke-view-prefs' }
  )
);
