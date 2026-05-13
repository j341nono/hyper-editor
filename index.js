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
};

// ──────────────────────────────────────────────────────────────────────────────
// Renderer Process – editor overlay
// ──────────────────────────────────────────────────────────────────────────────

exports.decorateTerm = function decorateTerm(Term, {React}) {
  class HyperEditor extends React.PureComponent {
    constructor(props) {
      super(props);
      this.state = {
        isOpen: false,
        showInput: true,
        filePath: '',
        status: '',
      };
      this.containerRef = React.createRef();
      this.inputRef = React.createRef();
      this.view = null;
      this._onKey = this._onKey.bind(this);
      this._onInputKey = this._onInputKey.bind(this);
    }

    componentDidMount() {
      window.addEventListener('keydown', this._onKey, true);
    }

    componentWillUnmount() {
      window.removeEventListener('keydown', this._onKey, true);
      this._destroyView();
    }

    // ── toggle ──────────────────────────────────────────────────────────────

    _onKey(e) {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        e.stopPropagation();
        this.state.isOpen ? this._close() : this._open();
      }
    }

    _open() {
      this.setState({isOpen: true, showInput: true, status: ''}, () => {
        this.inputRef.current && this.inputRef.current.focus();
      });
    }

    _close() {
      this._destroyView();
      this.setState({isOpen: false, showInput: true, filePath: '', status: ''});
    }

    _destroyView() {
      if (this.view) {
        this.view.destroy();
        this.view = null;
      }
    }

    // ── file operations ──────────────────────────────────────────────────────

    _onInputKey(e) {
      if (e.key === 'Enter') this._loadFile(e.currentTarget.value);
      else if (e.key === 'Escape') this._close();
    }

    async _loadFile(raw) {
      const filePath = (raw || '').trim();
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
          // new file – start with empty buffer
        }
      }
      this.setState({showInput: false, filePath}, () => this._initView(content));
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

    // ── CodeMirror initialisation ────────────────────────────────────────────

    _langExt(fp) {
      if (!fp) return [];
      const ext = fp.split('.').pop().toLowerCase();
      try {
        switch (ext) {
          case 'js': {
            const {javascript} = require('@codemirror/lang-javascript');
            return [javascript()];
          }
          case 'jsx': {
            const {javascript} = require('@codemirror/lang-javascript');
            return [javascript({jsx: true})];
          }
          case 'ts': {
            const {javascript} = require('@codemirror/lang-javascript');
            return [javascript({typescript: true})];
          }
          case 'tsx': {
            const {javascript} = require('@codemirror/lang-javascript');
            return [javascript({typescript: true, jsx: true})];
          }
          case 'json': {
            const {json} = require('@codemirror/lang-json');
            return [json()];
          }
          case 'css': {
            const {css} = require('@codemirror/lang-css');
            return [css()];
          }
          case 'html':
          case 'htm': {
            const {html} = require('@codemirror/lang-html');
            return [html()];
          }
          case 'md': {
            const {markdown} = require('@codemirror/lang-markdown');
            return [markdown()];
          }
          case 'py': {
            const {python} = require('@codemirror/lang-python');
            return [python()];
          }
          default:
            return [];
        }
      } catch (_) {
        return [];
      }
    }

    _initView(content) {
      if (!this.containerRef.current) return;
      this._destroyView();

      try {
        const {
          EditorView,
          keymap,
          lineNumbers,
          drawSelection,
          highlightActiveLine,
          highlightActiveLineGutter,
        } = require('@codemirror/view');
        const {EditorState} = require('@codemirror/state');
        const {vim, Vim} = require('@replit/codemirror-vim');
        const {
          defaultKeymap,
          historyKeymap,
          history,
          indentWithTab,
        } = require('@codemirror/commands');
        const {
          syntaxHighlighting,
          defaultHighlightStyle,
          bracketMatching,
          indentOnInput,
        } = require('@codemirror/language');
        const {oneDark} = require('@codemirror/theme-one-dark');

        const self = this;

        // Define (or re-define) ex commands bound to this instance
        Vim.defineEx('write', 'w', (_, params) => {
          const fp = params && params.args && params.args[0] ? params.args[0] : null;
          self._save(fp);
        });
        Vim.defineEx('edit', 'e', (_, params) => {
          if (params && params.args && params.args[0]) self._loadFile(params.args[0]);
        });
        Vim.defineEx('quit', 'q', () => self._close());
        Vim.defineEx('wq', 'wq', async (_, params) => {
          const fp = params && params.args && params.args[0] ? params.args[0] : null;
          await self._save(fp);
          self._close();
        });

        const state = EditorState.create({
          doc: content,
          extensions: [
            vim(),
            lineNumbers(),
            history(),
            drawSelection(),
            bracketMatching(),
            indentOnInput(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
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
              if (update.docChanged && self.state.status) {
                self.setState({status: ''});
              }
            }),
          ],
        });

        this.view = new EditorView({state, parent: this.containerRef.current});
        this.view.focus();
      } catch (err) {
        console.error('[hyper-editor]', err);
        this.setState({status: `E: Failed to load editor – ${err.message}`});
      }
    }

    // ── render ───────────────────────────────────────────────────────────────

    render() {
      return React.createElement(
        'div',
        {style: S.root},
        React.createElement(Term, this.props),
        this.state.isOpen ? this._renderOverlay() : null
      );
    }

    _renderOverlay() {
      const {showInput, filePath, status} = this.state;

      if (showInput) {
        return React.createElement(
          'div',
          {style: S.overlay},
          this._renderHeader('Open File'),
          React.createElement(
            'div',
            {style: S.inputBody},
            React.createElement(
              'div',
              {style: S.inputRow},
              React.createElement('span', {style: S.inputPrefix}, ':e '),
              React.createElement('input', {
                ref: this.inputRef,
                style: S.input,
                placeholder: '~/path/to/file   (Enter = empty buffer, Esc = cancel)',
                onKeyDown: this._onInputKey,
                spellCheck: false,
                autoCorrect: 'off',
                autoCapitalize: 'off',
              })
            )
          )
        );
      }

      return React.createElement(
        'div',
        {style: S.overlay},
        this._renderHeader(filePath || '[No Name]'),
        React.createElement('div', {ref: this.containerRef, style: S.editor}),
        status
          ? React.createElement('div', {style: S.statusBar}, status)
          : null
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
  root: {
    position: 'relative',
    width: '100%',
    height: '100%',
  },
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
    fontSize: '18px',
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
  },
  hint: {
    color: '#5c6370',
    fontSize: '11px',
    flexShrink: 0,
  },
  editor: {
    flex: 1,
    overflow: 'hidden',
  },
  inputBody: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    background: '#21252b',
    border: '1px solid #3e4451',
    borderRadius: '4px',
    padding: '8px 12px',
    width: '100%',
    maxWidth: '640px',
  },
  inputPrefix: {
    color: '#61afef',
    fontWeight: 'bold',
    marginRight: '6px',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    color: '#abb2bf',
    fontFamily: 'monospace',
    fontSize: '14px',
    outline: 'none',
  },
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
