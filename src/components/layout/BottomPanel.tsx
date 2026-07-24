import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useUIStore, BottomPanelView } from '../../stores';
import { TerminalPanel } from '../terminal';
import { Icon, IconName } from '../icons';
import { ProblemsView, OutputView, DebugView } from './BottomPanelViews';

interface PanelTab {
  id: BottomPanelView;
  label: string;
  icon: IconName;
}

const panelTabs: PanelTab[] = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'problems', label: 'Problems', icon: 'problems' },
  { id: 'output', label: 'Output', icon: 'output' },
  { id: 'debug', label: 'Debug', icon: 'debug' },
];

export const BottomPanel: React.FC = () => {
  const { 
    isBottomPanelVisible, 
    activeBottomPanelView, 
    setBottomPanelView, 
    toggleBottomPanel,
    bottomPanelHeight 
  } = useUIStore();

  if (!isBottomPanelVisible) {
    return null;
  }

  const renderContent = () => {
    switch (activeBottomPanelView) {
      case 'terminal':
        // embedded: BottomPanel already owns Terminal/Problems/Output/Debug tabs
        return <TerminalPanel embedded />;
      case 'problems':
        return <ProblemsView />;
      case 'output':
        return <OutputView />;
      case 'debug':
        return <DebugView />;
      default:
        return null;
    }
  };

  return (
    <View style={[styles.container, { height: bottomPanelHeight }]}>
      {/* Panel tabs */}
      <View style={styles.tabBar}>
        <View style={styles.tabs}>
          {panelTabs.map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.tab,
                activeBottomPanelView === tab.id && styles.activeTab
              ]}
              onPress={() => setBottomPanelView(tab.id)}
            >
              <Icon
                name={tab.icon}
                size={13}
                color={activeBottomPanelView === tab.id ? '#ffffff' : '#969696'}
              />
              <Text
                style={[
                  styles.tabText,
                  activeBottomPanelView === tab.id && styles.activeTabText
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.closeButton} onPress={toggleBottomPanel}>
          <Icon name="close" size={16} color="#969696" />
        </TouchableOpacity>
      </View>
      
      {/* Panel content */}
      <View style={styles.content}>
        {renderContent()}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1e1e1e',
    borderTopWidth: 1,
    borderTopColor: '#333333',
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
    height: 35,
    paddingHorizontal: 8,
  },
  tabs: {
    flexDirection: 'row',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: '#007acc',
  },
  tabText: {
    fontSize: 12,
    color: '#969696',
    marginLeft: 6,
  },
  activeTabText: {
    color: '#ffffff',
  },
  closeButton: {
    padding: 4,
  },
  closeButtonText: {
    fontSize: 16,
    color: '#969696',
  },
  content: {
    flex: 1,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    fontSize: 14,
    color: '#666666',
  },
});

export default BottomPanel;
