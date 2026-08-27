import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useUIStore, useTerminalStore, MobileView } from '../../stores';
import { Icon, IconName } from '../icons';
import {uiColors, uiFonts, uiRadii} from '../../theme';

interface TabItem {
  id: MobileView;
  label: string;
  icon: IconName;
}

const tabs: TabItem[] = [
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'editor', label: 'Editor', icon: 'editor' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const ACTIVE = uiColors.accentText;
const INACTIVE = uiColors.textMuted;

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
            style={[styles.tab, focused && styles.tabFocused]}
            onPress={() => setActiveView(tab.id)}
            activeOpacity={0.7}
          >
            <View style={styles.iconWrap}>
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
    justifyContent: 'space-around',
    backgroundColor: uiColors.canvas,
    borderTopWidth: 1,
    borderTopColor: uiColors.border,
    paddingHorizontal: 12,
    paddingTop: 7,
    paddingBottom: 8,
    minHeight: 64,
  },
  tab: {
    flex: 1,
    maxWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    paddingVertical: 5,
    marginHorizontal: 2,
    borderRadius: uiRadii.large,
  },
  tabFocused: {
    backgroundColor: uiColors.accentSoft,
  },
  iconWrap: {
    minHeight: 23,
    justifyContent: 'center',
  },
  label: {
    fontFamily: uiFonts.medium,
    fontSize: 11,
    marginTop: 2,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: uiColors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 9,
    fontWeight: '700',
  },
});

export default BottomTabBar;
