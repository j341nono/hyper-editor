'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Main Process – file I/O via IPC
// ──────────────────────────────────────────────────────────────────────────────

let _ipcHandlersReady = false;

exports.onWindow = function onWindow() {
  if (_ipcHandlersReady) return;
  _ipcHandlersReady = true;

  const {ipcMain} = require('electron');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

  ipcMain.handle('hyper-editor:read-file', (_, filePath) =>
    fs.promises.readFile(expand(filePath), 'utf8')
  );

  ipcMain.handle('hyper-editor:write-file', async (_, filePath, content) => {
    const abs = expand(filePath);
    await fs.promises.mkdir(path.dirname(abs), {recursive: true});
    await fs.promises.writeFile(abs, content, 'utf8');
  });

  ipcMain.handle('hyper-editor:list-dir', async (_, dirPath) => {
    const abs = expand(dirPath || os.homedir());
    const entries = await fs.promises.readdir(abs, {withFileTypes: true});
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({name: e.name, isDir: e.isDirectory()}))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });
};

// ──────────────────────────────────────────────────────────────────────────────
// Redux – inject terminal CWD into term props
// ──────────────────────────────────────────────────────────────────────────────

exports.mapTermsState = (state, map) =>
  Object.assign({}, map, {sessions: state.sessions});

exports.getTermProps = (uid, parentProps, props) => {
  const session = parentProps.sessions && parentProps.sessions[uid];
  return Object.assign({}, props, {
    _editorCwd: session ? session.cwd : null,
  });
};

// ──────────────────────────────────────────────────────────────────────────────
// Renderer Process – editor overlay
// ──────────────────────────────────────────────────────────────────────────────

exports.decorateTerm = function decorateTerm(Term, {React}) {
  function fuzzyMatch(name, query) {
    if (!query) return true;
    const s = name.toLowerCase();
    const q = query.toLowerCase();
    let qi = 0;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) qi++;
    }
    return qi === q.length;
  }

  class HyperEditor extends React.PureComponent {
    constructor(props) {
      super(props);
      this.state = {
        isOpen: false,
        showPicker: true,
        filePath: '',
        status: '',
        query: '',
        files: [],
        pickerCwd: '',
        selectedIdx: 0,
      };
      this.containerRef = React.createRef();
      this.queryRef = React.createRef();
      this.view = null;
      this._onKey = this._onKey.bind(this);
      this._onQueryChange = this._onQueryChange.bind(this);
      this._onQueryKey = this._onQueryKey.bind(this);
    }

    componentDidMount() {
      window.addEventListener('keydown', this._onKey, true);
    }

    componentWillUnmount() {
      window.removeEventListener('keydown', this._onKey, true);
      this._destroyView();
    }

    _onKey(e) {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        e.stopPropagation();
        this.state.isOpen ? this._close() : this._openPicker();
      }
    }

    async _openPicker() {
      const cwd = this.props._editorCwd || require('os').homedir();
      const files = await this._listDir(cwd);
      this.setState(
        {isOpen: true, showPicker: true, status: '', query: '', files, pickerCwd: cwd, selectedIdx: 0},
        () => this.queryRef.current && this.queryRef.current.focus()
      );
    }

    _close() {
      this._destroyView();
      this.setState({isOpen: false, showPicker: true, filePath: '', status: '', query: '', files: []});
    }

    _destroyView() {
      if (this.view) {
        this.view.destroy();
        this.view = null;
      }
    }

    async _listDir(dir) {
      try {
        const {ipcRenderer} = require('electron');
        return await ipcRenderer.invoke('hyper-editor:list-dir', dir);
      } catch (_) {
        return [];
      }
    }

    _filtered() {
      const {files, query} = this.state;
      return query ? files.filter((f) => fuzzyMatch(f.name, query)) : files;
    }

    _onQueryChange(e) {
      this.setState({query: e.target.value, selectedIdx: 0});
    }

    async _onQueryKey(e) {
      const filtered = this._filtered();
      if (e.key === 'Escape') {
        this._close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.setState((s) => ({selectedIdx: Math.min(s.selectedIdx + 1, filtered.length - 1)}));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.setState((s) => ({selectedIdx: Math.max(s.selectedIdx - 1, 0)}));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = filtered[this.state.selectedIdx];
        if (selected) {
          await this._pickItem(selected);
        } else if (this.state.query.trim()) {
          this._loadFile(this.state.query.trim());
        }
      }
    }

    async _pickItem(item) {
      const path = require('path');
      const fullPath = path.join(this.state.pickerCwd, item.name);
      if (item.isDir) {
        const files = await this._listDir(fullPath);
        this.setState({files, query: '', selectedIdx: 0, pickerCwd: fullPath});
      } else {
        this._loadFile(fullPath);
      }
    }

    async _loadFile(rawPath) {
      const filePath = (rawPath || '').trim();
      let content = '';
      if (filePath) {
        try {
          const {ipcRenderer} = require('electron');
          content = await ipcRenderer.invoke('hyper-editor:read-file', filePath);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            this.setState({status: `E: ${err.message}`});
            return;
          }
        }
      }
      this.setState({showPicker: false, filePath}, () => this._initView(content));
    }

    async _save(targetPath) {
      if (!this.view) return;
      const fp = (targetPath || this.state.filePath || '').trim();
      if (!fp) {
        this.setState({status: 'E: No file name'});
        return;
      }
      const content = this.view.state.doc.toString();
      try {
        const {ipcRenderer} = require('electron');
        await ipcRenderer.invoke('hyper-editor:write-file', fp, content);
        const lines = content.split('\n').length;
        const bytes = new TextEncoder().encode(content).length;
        this.setState({filePath: fp, status: `"${fp}" ${lines}L, ${bytes}B written`});
      } catch (err) {
        this.setState({status: `E: ${err.message}`});
      }
    }

    _langExt(fp) {
      if (!fp) return [];
      const ext = fp.split('.').pop().toLowerCase();
      try {
        switch (ext) {
          case 'js':
          case 'jsx': {
            const {javascript} = require('@codemirror/lang-javascript');
            return [javascript({jsx: ext === 'jsx'})];
          }
          case 'ts':
          case 'tsx': {
            const {javascript} = require('@codemirror/lang-javascript');
            return [javascript({typescript: true, jsx: ext === 'tsx'})];
          }
          case 'json': { const {json}     = require('@codemirror/lang-json');     return [json()];     }
          case 'css':  { const {css}      = require('@codemirror/lang-css');      return [css()];      }
          case 'html':
          case 'htm':  { const {html}     = require('@codemirror/lang-html');     return [html()];     }
          case 'md':   { const {markdown} = require('@codemirror/lang-markdown'); return [markdown()]; }
          case 'py':   { const {python}   = require('@codemirror/lang-python');   return [python()];   }
          default:     return [];
        }
      } catch (_) {
        return [];
      }
    }

    _initView(content) {
      if (!this.containerRef.current) return;
      this._destroyView();
      try {
        const {EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter} =
          require('@codemirror/view');
        const {EditorState} = require('@codemirror/state');
        const {vim, Vim} = require('@replit/codemirror-vim');
        const {defaultKeymap, historyKeymap, history, indentWithTab} = require('@codemirror/commands');
        const {syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput} =
          require('@codemirror/language');
        const {oneDark} = require('@codemirror/theme-one-dark');
        const self = this;

        Vim.defineEx('write', 'w', (_, params) => {
          self._save(params && params.args && params.args[0] ? params.args[0] : null);
        });
        Vim.defineEx('edit', 'e', (_, params) => {
          if (params && params.args && params.args[0]) self._loadFile(params.args[0]);
        });
        Vim.defineEx('quit', 'q', () => self._close());
        Vim.defineEx('wq', 'wq', async (_, params) => {
          await self._save(params && params.args && params.args[0] ? params.args[0] : null);
          self._close();
        });

        const state = EditorState.create({
          doc: content,
          extensions: [
            vim(), lineNumbers(), history(), drawSelection(), bracketMatching(),
            indentOnInput(), highlightActiveLine(), highlightActiveLineGutter(),
            syntaxHighlighting(defaultHighlightStyle),
            keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
            oneDark,
            ...this._langExt(this.state.filePath),
            EditorView.theme({
              '&': {height: '100%', fontSize: '14px'},
              '.cm-scroller': {overflow: 'auto', height: '100%'},
              '.cm-content': {fontFamily: 'inherit'},
            }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && self.state.status) self.setState({status: ''});
            }),
          ],
        });

        this.view = new EditorView({state, parent: this.containerRef.current});
        this.view.focus();
      } catch (err) {
        console.error('[hyper-editor]', err);
        this.setState({status: `E: ${err.message}`});
      }
    }

    render() {
      return React.createElement(
        'div',
        {style: S.root},
        React.createElement(Term, this.props),
        this.state.isOpen ? this._renderOverlay() : null
      );
    }

    _renderOverlay() {
      return this.state.showPicker ? this._renderPicker() : this._renderEditor();
    }

    _renderPicker() {
      const {query, selectedIdx, status, pickerCwd} = this.state;
      const filtered = this._filtered();
      return React.createElement(
        'div',
        {style: S.overlay},
        this._renderHeader(pickerCwd || '~'),
        React.createElement(
          'div',
          {style: S.pickerBody},
          React.createElement(
            'div',
            {style: S.searchRow},
            React.createElement('span', {style: S.searchPrompt}, '>'),
            React.createElement('input', {
              ref: this.queryRef,
              style: S.searchInput,
              placeholder: 'Search files…  (arrows navigate, Enter open, Esc cancel)',
              value: query,
              onChange: this._onQueryChange,
              onKeyDown: this._onQueryKey,
              spellCheck: false,
              autoCorrect: 'off',
              autoCapitalize: 'off',
            })
          ),
          React.createElement(
            'div',
            {style: S.fileList},
            filtered.length === 0
              ? React.createElement('div', {style: S.emptyMsg}, query ? 'No matches' : 'Empty directory')
              : filtered.map((f, i) =>
                  React.createElement(
                    'div',
                    {
                      key: f.name,
                      style: Object.assign({}, S.fileItem, i === selectedIdx ? S.fileItemActive : {}),
                      onMouseEnter: () => this.setState({selectedIdx: i}),
                      onClick: () => this._pickItem(f),
                    },
                    React.createElement(
                      'span',
                      {style: f.isDir ? S.fileNameDir : S.fileNameFile},
                      f.name + (f.isDir ? '/' : '')
                    )
                  )
                )
          )
        ),
        status ? React.createElement('div', {style: S.statusBar}, status) : null
      );
    }

    _renderEditor() {
      const {filePath, status} = this.state;
      return React.createElement(
        'div',
        {style: S.overlay},
        this._renderHeader(filePath || '[No Name]'),
        React.createElement('div', {ref: this.containerRef, style: S.editor}),
        status ? React.createElement('div', {style: S.statusBar}, status) : null
      );
    }

    _renderHeader(title) {
      return React.createElement(
        'div',
        {style: S.header},
        React.createElement('span', {style: S.badge}, ' HYPER EDITOR '),
        React.createElement('span', {style: S.title}, title),
        React.createElement('span', {style: S.hint}, 'Ctrl+Shift+E to close')
      );
    }
  }

  return HyperEditor;
};

// ──────────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────────

const S = {
  root: {position: 'relative', width: '100%', height: '100%'},
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    background: '#282c34',
    color: '#abb2bf',
    fontFamily: 'monospace',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 12px',
    background: '#21252b',
    borderBottom: '1px solid #181a1f',
    fontSize: '13px',
    gap: '12px',
    flexShrink: 0,
    height: '28px',
  },
  badge: {
    background: '#98c379',
    color: '#21252b',
    fontWeight: 'bold',
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '3px',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#abb2bf',
  },
  hint: {color: '#5c6370', fontSize: '11px', flexShrink: 0},
  editor: {flex: 1, overflow: 'hidden'},
  pickerBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '16px',
    gap: '10px',
    overflow: 'hidden',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    background: '#21252b',
    border: '1px solid #3e4451',
    borderRadius: '4px',
    padding: '8px 12px',
    gap: '8px',
    flexShrink: 0,
  },
  searchPrompt: {color: '#61afef', fontWeight: 'bold', flexShrink: 0},
  searchInput: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    color: '#abb2bf',
    fontFamily: 'monospace',
    fontSize: '14px',
    outline: 'none',
  },
  fileList: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  fileItem: {padding: '5px 10px', borderRadius: '3px', cursor: 'pointer', fontSize: '13px'},
  fileItemActive: {background: '#3e4451'},
  fileNameDir: {color: '#61afef'},
  fileNameFile: {color: '#abb2bf'},
  emptyMsg: {color: '#5c6370', padding: '12px', textAlign: 'center'},
  statusBar: {
    padding: '2px 12px',
    background: '#21252b',
    borderTop: '1px solid #181a1f',
    fontSize: '12px',
    color: '#98c379',
    flexShrink: 0,
    minHeight: '20px',
    display: 'flex',
    alignItems: 'center',
  },
};
