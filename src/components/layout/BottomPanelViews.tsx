import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useEditorStore } from '../../stores';
import { useProcessStore } from '../../stores/processStore';
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
        <Text style={styles.emptyHint}>
          Syntax diagnostics appear when the editor language service reports them.
        </Text>
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

/**
 * Output panel — shows background process logs and open ports from ProcessNative.
 * Dev servers / builds spawned via ProcessNative stream here.
 */
export const OutputView: React.FC = () => {
  const { processes, ports, logs, isLoading, error, refresh, kill, clearLogs } =
    useProcessStore();

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>Processes & output</Text>
        <View style={styles.toolbarActions}>
          <TouchableOpacity style={styles.toolBtn} onPress={() => refresh()}>
            <Text style={styles.toolBtnText}>Refresh</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={() => clearLogs()}>
            <Text style={styles.toolBtnText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Running ({processes.filter(p => p.isRunning).length})
          {isLoading ? ' …' : ''}
        </Text>
        {processes.length === 0 ? (
          <Text style={styles.muted}>
            No background processes. Use the terminal for CLI, or spawn via ProcessNative.
          </Text>
        ) : (
          processes.map(p => (
            <View key={p.id} style={styles.procRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.procCmd} numberOfLines={1}>
                  #{p.id} {p.command}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {p.isRunning ? 'running' : 'stopped'} · {p.cwd}
                </Text>
              </View>
              {p.isRunning && (
                <TouchableOpacity style={styles.killBtn} onPress={() => kill(p.id)}>
                  <Text style={styles.killBtnText}>Kill</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Ports</Text>
        {ports.length === 0 ? (
          <Text style={styles.muted}>No monitored ports open (3000, 5173, 8080, …)</Text>
        ) : (
          ports.map(port => (
            <Text key={`${port.port}-${port.processId}`} style={styles.logText}>
              :{port.port} → process {port.processId}
            </Text>
          ))
        )}
      </View>

      <View style={[styles.section, { flex: 1 }]}>
        <Text style={styles.sectionTitle}>Log</Text>
        <ScrollView style={styles.logBox}>
          {logs.length === 0 ? (
            <Text style={styles.muted}>
              Process stdout/stderr appears here. Terminal I/O stays in the Terminal tab.
            </Text>
          ) : (
            logs.map((line, i) => (
              <Text
                key={`${line.at}-${i}`}
                style={[
                  styles.logText,
                  line.stream === 'stderr' && styles.logErr,
                  line.stream === 'system' && styles.logSys,
                ]}
              >
                {line.stream === 'system' ? '' : `[${line.processId}] `}
                {line.data}
              </Text>
            ))
          )}
          {isLoading && logs.length === 0 ? (
            <ActivityIndicator size="small" color="#8b5cf6" style={{ marginTop: 8 }} />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
};

export const DebugView: React.FC = () => {
  const { ports, processes } = useProcessStore();
  useEffect(() => {
    useProcessStore.getState().refresh();
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.logBox}>
        <Text style={styles.sectionTitle}>Debug / runtime snapshot</Text>
        <Text style={styles.logText}>
          No source-level debugger is attached. Use this panel for a quick process snapshot.
        </Text>
        <Text style={styles.logText}> </Text>
        <Text style={styles.logText}>Processes: {processes.length}</Text>
        <Text style={styles.logText}>Open ports: {ports.map(p => p.port).join(', ') || 'none'}</Text>
        <Text style={styles.logText}> </Text>
        <Text style={styles.muted}>
          Tip: run servers in the Terminal tab (`npm start`, `npx vite`, …). Pure JS packages
          install fine; native node-gyp modules are not supported without a C toolchain.
        </Text>
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
  emptyHint: {
    color: '#555',
    fontSize: 11,
    marginTop: 6,
    textAlign: 'center',
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
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  toolbarTitle: {
    color: '#e4e4e7',
    fontSize: 12,
    fontWeight: '600',
  },
  toolbarActions: {
    flexDirection: 'row',
  },
  toolBtn: {
    marginLeft: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#2a2a2a',
    borderRadius: 4,
  },
  toolBtnText: {
    color: '#c4b5fd',
    fontSize: 11,
  },
  section: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  sectionTitle: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  procRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2a2a2a',
  },
  procCmd: {
    color: '#e4e4e7',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  killBtn: {
    backgroundColor: '#7f1d1d',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  killBtnText: {
    color: '#fecaca',
    fontSize: 11,
    fontWeight: '600',
  },
  logBox: {
    flex: 1,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  logText: {
    color: '#a1a1aa',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  logErr: {
    color: '#fca5a5',
  },
  logSys: {
    color: '#fde68a',
  },
  muted: {
    color: '#666',
    fontSize: 11,
    marginBottom: 4,
  },
  errorText: {
    color: '#f87171',
    fontSize: 11,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
});
