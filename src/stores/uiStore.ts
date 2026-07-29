import { create } from 'zustand';

export type SidebarView = 'explorer' | 'search' | 'git' | 'settings';
export type BottomPanelView = 'terminal' | 'problems' | 'output' | 'debug';
// Top-level views used by the mobile (phone) bottom tab layout.
export type MobileView = 'files' | 'editor' | 'terminal' | 'git' | 'settings';

interface UIState {
  // Mobile top-level view (phone layout)
  activeView: MobileView;

  // Sidebar
  isSidebarVisible: boolean;
  activeSidebarView: SidebarView;
  sidebarWidth: number;
  
  // Bottom panel
  isBottomPanelVisible: boolean;
  activeBottomPanelView: BottomPanelView;
  bottomPanelHeight: number;
  
  // Activity bar
  isActivityBarVisible: boolean;
  
  // Fullscreen mode
  isFullscreen: boolean;
  
  // Actions
  toggleSidebar: () => void;
  setSidebarView: (view: SidebarView) => void;
  setSidebarWidth: (width: number) => void;
  
  toggleBottomPanel: () => void;
  setBottomPanelView: (view: BottomPanelView) => void;
  setBottomPanelHeight: (height: number) => void;
  
  toggleActivityBar: () => void;
  toggleFullscreen: () => void;

  setActiveView: (view: MobileView) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeView: 'editor',
  isSidebarVisible: true,
  activeSidebarView: 'explorer',
  sidebarWidth: 250,
  
  isBottomPanelVisible: true,
  activeBottomPanelView: 'terminal',
  bottomPanelHeight: 200,
  
  isActivityBarVisible: true,
  isFullscreen: false,

  toggleSidebar: () => {
    set(state => ({ isSidebarVisible: !state.isSidebarVisible }));
  },

  setSidebarView: (view: SidebarView) => {
    set(state => ({
      activeSidebarView: view,
      isSidebarVisible: state.activeSidebarView === view ? !state.isSidebarVisible : true,
    }));
  },

  setSidebarWidth: (width: number) => {
    set({ sidebarWidth: Math.max(150, Math.min(400, width)) });
  },

  toggleBottomPanel: () => {
    set(state => ({ isBottomPanelVisible: !state.isBottomPanelVisible }));
  },

  setBottomPanelView: (view: BottomPanelView) => {
    set({
      activeBottomPanelView: view,
      isBottomPanelVisible: true,
    });
  },

  setBottomPanelHeight: (height: number) => {
    set({ bottomPanelHeight: Math.max(100, Math.min(500, height)) });
  },

  toggleActivityBar: () => {
    set(state => ({ isActivityBarVisible: !state.isActivityBarVisible }));
  },

  toggleFullscreen: () => {
    set(state => ({ isFullscreen: !state.isFullscreen }));
  },

  setActiveView: (view: MobileView) => {
    set({ activeView: view });
  },
}));
