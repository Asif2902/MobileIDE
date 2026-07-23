import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { useUIStore, SidebarView } from '../../stores';
import { Icon, IconName } from '../icons';

interface ActivityBarItem {
  id: SidebarView;
  icon: IconName;
  label: string;
}

const activityBarItems: ActivityBarItem[] = [
  { id: 'explorer', icon: 'files', label: 'Explorer' },
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'git', icon: 'git', label: 'Source Control' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];

export const ActivityBar: React.FC = () => {
  const { activeSidebarView, setSidebarView, isSidebarVisible } = useUIStore();

  return (
    <View style={styles.container}>
      {activityBarItems.map((item) => {
        const active = activeSidebarView === item.id && isSidebarVisible;
        return (
          <TouchableOpacity
            key={item.id}
            style={[styles.item, active && styles.activeItem]}
            onPress={() => setSidebarView(item.id)}
          >
            <Icon name={item.icon} size={24} color={active ? '#ffffff' : '#858585'} />
            {active && <View style={styles.activeIndicator} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: 48,
    backgroundColor: '#333333',
    alignItems: 'center',
    paddingTop: 8,
  },
  item: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  activeItem: {
    backgroundColor: '#252526',
  },
  activeIndicator: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 2,
    backgroundColor: '#ffffff',
  },
});

export default ActivityBar;
