import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useEditorStore } from '../../stores';
import { useProcessStore } from '../../stores/processStore';
import { MobileIDENativeModule } from '../../native';
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
  const { processes, ports, logs, isLoading, error, refresh, kill, clearLogs, startTask } =
    useProcessStore();

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const startDemo = (kind: 'web' | 'api') => {
    const script =
      kind === 'web'
        ? 'adev-run-web'
        : 'adev-run-api';
    startTask(kind === 'web' ? 'VITE' : 'EXPRESS', 'bash', ['-c', script], null, true).then(id => {
      if (id != null) {
        Alert.alert(
          kind === 'web' ? 'Vite starting' : 'API starting',
          kind === 'web'
            ? 'Installing if needed, then serving on :5173. Tap Open when ready.'
            : 'Installing if needed, then serving on :3000. Tap Open when ready.',
        );
      }
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>Run & preview</Text>
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

      {/* One-tap JS apps — no need to fight the terminal */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Start app (Node / Vite / Express)</Text>
        <View style={styles.runRow}>
          <TouchableOpacity style={styles.runBtn} onPress={() => startDemo('web')}>
            <Text style={styles.runBtnText}>▶ demo-web</Text>
            <Text style={styles.runBtnSub}>Vite :5173</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.runBtn, styles.runBtnApi]} onPress={() => startDemo('api')}>
            <Text style={styles.runBtnText}>▶ demo-api</Text>
            <Text style={styles.runBtnSub}>Express :3000</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.muted}>
          Or in Terminal: adev-run-web · adev-run-api · cd your-app && npm i && npm run dev
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Running ({processes.filter(p => p.isRunning).length})
          {isLoading ? ' …' : ''}
        </Text>
        {processes.length === 0 ? (
          <Text style={styles.muted}>Nothing running yet. Tap a Start button above.</Text>
        ) : (
          processes.map(p => (
            <View key={p.id} style={styles.procRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.procCmd} numberOfLines={1}>
                  #{p.id} {p.command}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {p.state.toLowerCase()} · {p.type.toLowerCase()} · {p.source.toLowerCase()} · {p.cwd}
                </Text>
              </View>
              {p.isRunning && p.source === 'BACKGROUND' && (
                <TouchableOpacity style={styles.killBtn} onPress={() => kill(p.id)}>
                  <Text style={styles.killBtnText}>Kill</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preview (tap Open)</Text>
        {ports.length === 0 ? (
          <Text style={styles.muted}>No open ports yet. Start demo-web or demo-api first.</Text>
        ) : (
          ports.map(port => (
            <View key={`${port.port}-${port.taskId}`} style={styles.portRow}>
              <Text style={styles.logText}>
                :{port.port} → task {port.taskId} · verified {port.source.toLowerCase()}
              </Text>
              <TouchableOpacity
                style={styles.openBtn}
                onPress={() => {
                  MobileIDENativeModule.openUrl(port.url).catch(e =>
                    Alert.alert('Open failed', e?.message || String(e)),
                  );
                }}
              >
                <Text style={styles.openBtnText}>Open</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
        <View style={styles.quickOpenRow}>
          {[5173, 3000, 4173, 8080].map(p => (
            <TouchableOpacity
              key={p}
              style={styles.quickOpenBtn}
              onPress={() => {
                MobileIDENativeModule.openUrl(`http://127.0.0.1:${p}`).catch(e =>
                  Alert.alert('Open failed', e?.message || String(e)),
                );
              }}
            >
              <Text style={styles.quickOpenText}>:{p}</Text>
            </TouchableOpacity>
          ))}
        </View>
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
          install normally; native node-gyp modules use the bundled Android C/C++ toolchain.
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
  runRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  runBtn: {
    flex: 1,
    backgroundColor: '#1e3a5f',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  runBtnApi: {
    backgroundColor: '#1a3d2e',
    borderColor: '#22c55e',
  },
  runBtnText: {
    color: '#f4f4f5',
    fontSize: 14,
    fontWeight: '700',
  },
  runBtnSub: {
    color: '#a1a1aa',
    fontSize: 11,
    marginTop: 2,
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
  portRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  openBtn: {
    backgroundColor: '#8b5cf6',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  openBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  quickOpenRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  quickOpenBtn: {
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  quickOpenText: {
    color: '#c4b5fd',
    fontSize: 11,
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
