import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useEditorStore } from '../../stores';
import { Icon } from '../icons';

export const ProblemsView: React.FC = () => {
  const { diagnostics, openFile } = useEditorStore();

  const allProblems: Array<{
    filePath: string;
    fileName: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
  }> = [];

  Object.entries(diagnostics).forEach(([filePath, diag]) => {
    const fileName = filePath.split('/').pop() || filePath;
    diag.problems.forEach(p => {
      allProblems.push({
        filePath,
        fileName,
        severity: p.severity,
        message: p.message,
        line: p.startLine,
        column: p.startColumn,
      });
    });
  });

  if (allProblems.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="problems" size={32} color="#6a9955" />
        <Text style={styles.emptyTitle}>No problems detected in workspace</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {allProblems.map((prob, index) => (
        <TouchableOpacity
          key={`${prob.filePath}-${prob.line}-${prob.column}-${index}`}
          style={styles.problemItem}
          onPress={() => openFile(prob.filePath)}
        >
          <Icon
            name={prob.severity === 'error' ? 'close' : 'problems'}
            size={14}
            color={prob.severity === 'error' ? '#f44747' : '#cca700'}
          />
          <View style={styles.problemTextContainer}>
            <Text style={styles.problemMessage} numberOfLines={2}>
              {prob.message}
            </Text>
            <Text style={styles.problemLocation}>
              {prob.fileName} [{prob.line}, {prob.column}]
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
};

export const OutputView: React.FC = () => {
  return (
    <View style={styles.container}>
      <ScrollView style={styles.logBox}>
        <Text style={styles.logText}>[MobileIDE Output Console]</Text>
        <Text style={styles.logText}>Ready. PTY shell runtime active.</Text>
      </ScrollView>
    </View>
  );
};

export const DebugView: React.FC = () => {
  return (
    <View style={styles.container}>
      <ScrollView style={styles.logBox}>
        <Text style={styles.logText}>[Debug Console]</Text>
        <Text style={styles.logText}>No active debug session attached.</Text>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyTitle: {
    color: '#888888',
    fontSize: 13,
    marginTop: 10,
  },
  problemItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#252526',
  },
  problemTextContainer: {
    marginLeft: 8,
    flex: 1,
  },
  problemMessage: {
    color: '#cccccc',
    fontSize: 12,
  },
  problemLocation: {
    color: '#777777',
    fontSize: 11,
    marginTop: 2,
  },
  logBox: {
    flex: 1,
    padding: 12,
  },
  logText: {
    color: '#858585',
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
});
