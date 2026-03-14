// themes.js — Theme registry for nterm-js
// Single source of truth: CSS variables (chrome) + xterm.js colors (terminal)
// Adding a theme = adding one object here. Nothing else to touch.

(() => {
    'use strict';

    const themes = {

        // ─── Catppuccin Mocha ─────────────────────────────────
        'catppuccin-mocha': {
            label: 'Catppuccin Mocha',
            type: 'dark',
            css: {
                '--bg-base':       '#1e1e2e',
                '--bg-surface':    '#181825',
                '--bg-overlay':    '#313244',
                '--bg-hover':      '#45475a',
                '--text-primary':  '#cdd6f4',
                '--text-secondary':'#a6adc8',
                '--text-muted':    '#6c7086',
                '--border':        '#313244',
                '--accent':        '#89b4fa',
                '--accent-hover':  '#74c7ec',
                '--green':         '#a6e3a1',
                '--red':           '#f38ba8',
                '--yellow':        '#f9e2af',
                '--tab-active':    '#1e1e2e',
                '--tab-inactive':  '#181825',
                '--input-bg':      '#313244',
                '--scrollbar':     '#45475a',
                '--modal-bg':      '#1e1e2e',
                '--modal-shadow':  'rgba(0, 0, 0, 0.6)',
            },
            xterm: {
                background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
                selectionBackground: '#45475a',
                black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
                blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
                brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
                brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
                brightCyan: '#94e2d5', brightWhite: '#a6adc8',
            },
        },

        // ─── Catppuccin Latte ─────────────────────────────────
        'catppuccin-latte': {
            label: 'Catppuccin Latte',
            type: 'light',
            css: {
                '--bg-base':       '#eff1f5',
                '--bg-surface':    '#e6e9ef',
                '--bg-overlay':    '#ccd0da',
                '--bg-hover':      '#bcc0cc',
                '--text-primary':  '#4c4f69',
                '--text-secondary':'#5c5f77',
                '--text-muted':    '#8c8fa1',
                '--border':        '#ccd0da',
                '--accent':        '#1e66f5',
                '--accent-hover':  '#04a5e5',
                '--green':         '#40a02b',
                '--red':           '#d20f39',
                '--yellow':        '#df8e1d',
                '--tab-active':    '#eff1f5',
                '--tab-inactive':  '#e6e9ef',
                '--input-bg':      '#ccd0da',
                '--scrollbar':     '#bcc0cc',
                '--modal-bg':      '#eff1f5',
                '--modal-shadow':  'rgba(0, 0, 0, 0.3)',
            },
            xterm: {
                background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78',
                selectionBackground: '#ccd0da',
                black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
                blue: '#1e66f5', magenta: '#8839ef', cyan: '#179299', white: '#acb0be',
                brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
                brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#8839ef',
                brightCyan: '#179299', brightWhite: '#bcc0cc',
            },
        },

        // ─── Darcula (JetBrains) ──────────────────────────────
        'darcula': {
            label: 'Darcula',
            type: 'dark',
            css: {
                '--bg-base':       '#2b2b2b',
                '--bg-surface':    '#242424',
                '--bg-overlay':    '#3c3f41',
                '--bg-hover':      '#4e5254',
                '--text-primary':  '#a9b7c6',
                '--text-secondary':'#8a9199',
                '--text-muted':    '#606366',
                '--border':        '#3c3f41',
                '--accent':        '#6897bb',
                '--accent-hover':  '#7ab0d4',
                '--green':         '#6a8759',
                '--red':           '#cc7832',
                '--yellow':        '#ffc66d',
                '--tab-active':    '#2b2b2b',
                '--tab-inactive':  '#242424',
                '--input-bg':      '#45494a',
                '--scrollbar':     '#4e5254',
                '--modal-bg':      '#2b2b2b',
                '--modal-shadow':  'rgba(0, 0, 0, 0.7)',
            },
            xterm: {
                background: '#2b2b2b', foreground: '#a9b7c6', cursor: '#bbbbbb',
                selectionBackground: '#214283',
                black: '#3c3f41', red: '#cc7832', green: '#6a8759', yellow: '#ffc66d',
                blue: '#6897bb', magenta: '#9876aa', cyan: '#629755', white: '#a9b7c6',
                brightBlack: '#606366', brightRed: '#d47a3a', brightGreen: '#7ea668',
                brightYellow: '#ffd080', brightBlue: '#7eadd4', brightMagenta: '#b09acf',
                brightCyan: '#73a663', brightWhite: '#c8cdd2',
            },
        },

        // ─── Nord ─────────────────────────────────────────────
        'nord': {
            label: 'Nord',
            type: 'dark',
            css: {
                '--bg-base':       '#2e3440',
                '--bg-surface':    '#292e39',
                '--bg-overlay':    '#3b4252',
                '--bg-hover':      '#434c5e',
                '--text-primary':  '#d8dee9',
                '--text-secondary':'#b0b8c8',
                '--text-muted':    '#6a7384',
                '--border':        '#3b4252',
                '--accent':        '#88c0d0',
                '--accent-hover':  '#8fbcbb',
                '--green':         '#a3be8c',
                '--red':           '#bf616a',
                '--yellow':        '#ebcb8b',
                '--tab-active':    '#2e3440',
                '--tab-inactive':  '#292e39',
                '--input-bg':      '#3b4252',
                '--scrollbar':     '#434c5e',
                '--modal-bg':      '#2e3440',
                '--modal-shadow':  'rgba(0, 0, 0, 0.6)',
            },
            xterm: {
                background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
                selectionBackground: '#434c5e',
                black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
                blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
                brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
                brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
                brightCyan: '#8fbcbb', brightWhite: '#eceff4',
            },
        },

        // ─── Gruvbox Dark ─────────────────────────────────────
        'gruvbox-dark': {
            label: 'Gruvbox Dark',
            type: 'dark',
            css: {
                '--bg-base':       '#282828',
                '--bg-surface':    '#1d2021',
                '--bg-overlay':    '#3c3836',
                '--bg-hover':      '#504945',
                '--text-primary':  '#ebdbb2',
                '--text-secondary':'#bdae93',
                '--text-muted':    '#7c6f64',
                '--border':        '#3c3836',
                '--accent':        '#83a598',
                '--accent-hover':  '#8ec07c',
                '--green':         '#b8bb26',
                '--red':           '#fb4934',
                '--yellow':        '#fabd2f',
                '--tab-active':    '#282828',
                '--tab-inactive':  '#1d2021',
                '--input-bg':      '#3c3836',
                '--scrollbar':     '#504945',
                '--modal-bg':      '#282828',
                '--modal-shadow':  'rgba(0, 0, 0, 0.6)',
            },
            xterm: {
                background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2',
                selectionBackground: '#504945',
                black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
                blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
                brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
                brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
                brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
            },
        },

        // ─── Gruvbox Light ────────────────────────────────────
        'gruvbox-light': {
            label: 'Gruvbox Light',
            type: 'light',
            css: {
                '--bg-base':       '#fbf1c7',
                '--bg-surface':    '#f2e5bc',
                '--bg-overlay':    '#ebdbb2',
                '--bg-hover':      '#d5c4a1',
                '--text-primary':  '#3c3836',
                '--text-secondary':'#504945',
                '--text-muted':    '#928374',
                '--border':        '#d5c4a1',
                '--accent':        '#427b58',
                '--accent-hover':  '#076678',
                '--green':         '#79740e',
                '--red':           '#9d0006',
                '--yellow':        '#b57614',
                '--tab-active':    '#fbf1c7',
                '--tab-inactive':  '#f2e5bc',
                '--input-bg':      '#ebdbb2',
                '--scrollbar':     '#d5c4a1',
                '--modal-bg':      '#fbf1c7',
                '--modal-shadow':  'rgba(0, 0, 0, 0.25)',
            },
            xterm: {
                background: '#fbf1c7', foreground: '#3c3836', cursor: '#282828',
                selectionBackground: '#d5c4a1',
                black: '#fbf1c7', red: '#cc241d', green: '#98971a', yellow: '#d79921',
                blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
                brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e',
                brightYellow: '#b57614', brightBlue: '#076678', brightMagenta: '#8f3f71',
                brightCyan: '#427b58', brightWhite: '#3c3836',
            },
        },

        // ─── Solarized Dark ───────────────────────────────────
        'solarized-dark': {
            label: 'Solarized Dark',
            type: 'dark',
            css: {
                '--bg-base':       '#002b36',
                '--bg-surface':    '#002430',
                '--bg-overlay':    '#073642',
                '--bg-hover':      '#0a4050',
                '--text-primary':  '#839496',
                '--text-secondary':'#93a1a1',
                '--text-muted':    '#586e75',
                '--border':        '#073642',
                '--accent':        '#268bd2',
                '--accent-hover':  '#2aa198',
                '--green':         '#859900',
                '--red':           '#dc322f',
                '--yellow':        '#b58900',
                '--tab-active':    '#002b36',
                '--tab-inactive':  '#002430',
                '--input-bg':      '#073642',
                '--scrollbar':     '#0a4050',
                '--modal-bg':      '#002b36',
                '--modal-shadow':  'rgba(0, 0, 0, 0.6)',
            },
            xterm: {
                background: '#002b36', foreground: '#839496', cursor: '#839496',
                selectionBackground: '#073642',
                black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
                blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
                brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900',
                brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4',
                brightCyan: '#2aa198', brightWhite: '#fdf6e3',
            },
        },

        // ─── Solarized Light ──────────────────────────────────
        'solarized-light': {
            label: 'Solarized Light',
            type: 'light',
            css: {
                '--bg-base':       '#fdf6e3',
                '--bg-surface':    '#eee8d5',
                '--bg-overlay':    '#e6dfcc',
                '--bg-hover':      '#ddd6c1',
                '--text-primary':  '#657b83',
                '--text-secondary':'#586e75',
                '--text-muted':    '#93a1a1',
                '--border':        '#e6dfcc',
                '--accent':        '#268bd2',
                '--accent-hover':  '#2aa198',
                '--green':         '#859900',
                '--red':           '#dc322f',
                '--yellow':        '#b58900',
                '--tab-active':    '#fdf6e3',
                '--tab-inactive':  '#eee8d5',
                '--input-bg':      '#e6dfcc',
                '--scrollbar':     '#ddd6c1',
                '--modal-bg':      '#fdf6e3',
                '--modal-shadow':  'rgba(0, 0, 0, 0.2)',
            },
            xterm: {
                background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83',
                selectionBackground: '#e6dfcc',
                black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
                blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
                brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900',
                brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4',
                brightCyan: '#2aa198', brightWhite: '#fdf6e3',
            },
        },

        // ─── Corporate ────────────────────────────────────────
        // Navy chrome, light terminal — the "showing this to management" theme
        'corporate': {
            label: 'Corporate',
            type: 'light',
            css: {
                '--bg-base':       '#f5f6fa',
                '--bg-surface':    '#1b2a4a',
                '--bg-overlay':    '#243556',
                '--bg-hover':      '#2d4168',
                '--text-primary':  '#e8ecf4',
                '--text-secondary':'#b0bdd0',
                '--text-muted':    '#6b7fa0',
                '--border':        '#2d4168',
                '--accent':        '#4a90d9',
                '--accent-hover':  '#5ba0ec',
                '--green':         '#27ae60',
                '--red':           '#e74c3c',
                '--yellow':        '#f39c12',
                '--tab-active':    '#1b2a4a',
                '--tab-inactive':  '#152238',
                '--input-bg':      '#2d4168',
                '--scrollbar':     '#3a5280',
                '--modal-bg':      '#1b2a4a',
                '--modal-shadow':  'rgba(0, 0, 0, 0.5)',
            },
            // Terminal area overrides — light terminal in dark chrome
            terminalArea: {
                '--bg-base': '#ffffff',
            },
            xterm: {
                background: '#ffffff', foreground: '#1e293b', cursor: '#1b2a4a',
                selectionBackground: '#d0dff5',
                black: '#1e293b', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
                blue: '#2563eb', magenta: '#7c3aed', cyan: '#0891b2', white: '#e2e8f0',
                brightBlack: '#475569', brightRed: '#ef4444', brightGreen: '#22c55e',
                brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#8b5cf6',
                brightCyan: '#06b6d4', brightWhite: '#f8fafc',
            },
        },

        // ─── Corporate Dark ───────────────────────────────────
        // Navy chrome, dark terminal — the "NOC at 2am" variant
        'corporate-dark': {
            label: 'Corporate Dark',
            type: 'dark',
            css: {
                '--bg-base':       '#0f1a2e',
                '--bg-surface':    '#1b2a4a',
                '--bg-overlay':    '#243556',
                '--bg-hover':      '#2d4168',
                '--text-primary':  '#e8ecf4',
                '--text-secondary':'#b0bdd0',
                '--text-muted':    '#6b7fa0',
                '--border':        '#2d4168',
                '--accent':        '#4a90d9',
                '--accent-hover':  '#5ba0ec',
                '--green':         '#27ae60',
                '--red':           '#e74c3c',
                '--yellow':        '#f39c12',
                '--tab-active':    '#1b2a4a',
                '--tab-inactive':  '#152238',
                '--input-bg':      '#2d4168',
                '--scrollbar':     '#3a5280',
                '--modal-bg':      '#1b2a4a',
                '--modal-shadow':  'rgba(0, 0, 0, 0.6)',
            },
            xterm: {
                background: '#0f1a2e', foreground: '#c8d6e5', cursor: '#4a90d9',
                selectionBackground: '#243556',
                black: '#1b2a4a', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
                blue: '#3b82f6', magenta: '#8b5cf6', cyan: '#06b6d4', white: '#c8d6e5',
                brightBlack: '#3a5280', brightRed: '#f87171', brightGreen: '#4ade80',
                brightYellow: '#facc15', brightBlue: '#60a5fa', brightMagenta: '#a78bfa',
                brightCyan: '#22d3ee', brightWhite: '#e8ecf4',
            },
        },
    };

    // ─── Public API ───────────────────────────────────────────

    /** Get a theme definition by name */
    function getTheme(name) {
        return themes[name] || themes['catppuccin-mocha'];
    }

    /** Get ordered list of all theme names */
    function getThemeNames() {
        return Object.keys(themes);
    }

    /** Get label/type metadata for building selectors */
    function getThemeList() {
        return Object.entries(themes).map(([name, t]) => ({
            name,
            label: t.label,
            type: t.type,
        }));
    }

    /** Apply a theme — sets CSS variables on :root and returns xterm theme object */
    function applyTheme(name) {
        const theme = getTheme(name);
        const root = document.documentElement;
        const termArea = document.getElementById('terminal-area');

        // Apply CSS variables to :root
        for (const [prop, value] of Object.entries(theme.css)) {
            root.style.setProperty(prop, value);
        }

        // Corporate-style themes: terminal area gets its own background
        if (theme.terminalArea) {
            if (termArea) {
                termArea.style.background = theme.terminalArea['--bg-base'];
            }
        } else {
            if (termArea) {
                termArea.style.background = '';
            }
        }

        // Store theme type for any CSS that needs it (scrollbar colors etc.)
        root.setAttribute('data-theme', theme.type);
        root.setAttribute('data-theme-name', name);

        return theme.xterm;
    }

    /** Map legacy setting values to theme names */
    function migrateLegacyTheme(value) {
        if (value === 'dark') return 'catppuccin-mocha';
        if (value === 'light') return 'catppuccin-latte';
        if (themes[value]) return value;
        return 'catppuccin-mocha';
    }

    /** Get the Electron BrowserWindow background color for a theme */
    function getWindowBackground(name) {
        const theme = getTheme(name);
        return theme.css['--bg-base'];
    }

    // Expose globally
    window.NtermThemes = {
        getTheme,
        getThemeNames,
        getThemeList,
        applyTheme,
        migrateLegacyTheme,
        getWindowBackground,
    };

})();