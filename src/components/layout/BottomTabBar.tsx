import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useUIStore, useTerminalStore, MobileView } from '../../stores';
import { Icon, IconName } from '../icons';

interface TabItem {
  id: MobileView;
  label: string;
  icon: IconName;
}

const tabs: TabItem[] = [
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'editor', label: 'Editor', icon: 'editor' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const ACTIVE = '#8b5cf6';
const INACTIVE = '#8a8a92';

/**
 * Phone bottom navigation. Each tab swaps the full-screen primary view.
 */
export const BottomTabBar: React.FC = () => {
  const { activeView, setActiveView } = useUIStore();
  const { sessions } = useTerminalStore();
  const activeTerminals = sessions.filter(s => s.isAlive).length;

  return (
    <View style={styles.container}>
      {tabs.map(tab => {
        const focused = activeView === tab.id;
        const color = focused ? ACTIVE : INACTIVE;
        return (
          <TouchableOpacity
            key={tab.id}
            style={styles.tab}
            onPress={() => setActiveView(tab.id)}
            activeOpacity={0.7}
          >
            <View>
              <Icon name={tab.icon} size={22} color={color} />
              {tab.id === 'terminal' && activeTerminals > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{activeTerminals}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, { color }]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: '#181818',
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    paddingTop: 6,
    paddingBottom: 6,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  label: {
    fontSize: 10,
    marginTop: 3,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: '#8b5cf6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700',
  },
});

export default BottomTabBar;
