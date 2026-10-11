/**
 * Extension Editor - A Blockly-based Scratch/TurboWarp extension editor
 *
 * Defensive version: works even if Blockly fails to load
 */

import React, {useState, useEffect, useRef, useCallback, useMemo, Component} from 'react';
import {createPortal} from 'react-dom';
import LazyScratchBlocks from '../lib/tw-lazy-scratch-blocks.js';
import {
    TOOLBOX_CONFIG,
    BLOCK_DEFINITIONS,
    CODE_GENERATORS,
    javascriptGenerator
} from '../lib/block-definitions.js';
import {applyZhTranslations} from '../lib/scratch-blocks-zh.js';
import {FORGEXT_RUNTIME, withUtilInjection} from '../lib/forgeext-runtime.js';
// 登录只走 GitHub Device Flow：全程在页面内完成，不用 authorize 重定向，
// 也就不需要 buildGitHubAuthUrl / makeGitHubState。用户名/密码与邮箱验证码
// 相关的 login / register / sendEmailCode / verifyEmailCode 同样已不再引用。
import {getSession, logout as authLogout, getUserMeta, savePrevSession, getPrevSession, switchToPrevSession, clearLocalAuthData, startGitHubDeviceFlow, pollGitHubDeviceToken, fetchGitHubProfile, loginWithGitHub, loginWithPAT, getRegisteredAccounts, switchToAccount, ensureSiteAccount} from '../lib/auth.js';
import {
    listSaves, saveProject, deleteSave, exportSaveFile, parseSaveFileText,
    collectProjectState, restoreProjectState
} from '../lib/saves.js';
import {buildSyncUrl, parseSyncPayload, importSyncPayload} from '../lib/sync.js';
import CommunityPanel from './CommunityPanel.jsx';
import {FORMAT as COMMUNITY_FORMAT, parseCommunityEntry} from '../lib/community.js';
import {
    cloudAvailable, cloudSearchUsers, cloudListRelations, cloudFollow, cloudUnfollow
} from '../lib/cloud.js';
import {EXT_ADDONS, getAllAddons, getDirPlugins, getAddonState, setAddonState, applyExtAddons, getAddonOptions, setAddonOptions, removeCustomAddon, removeDirPlugin, installDirPluginFromGithub, importAddonFromSource, updateCustomAddonSource, importAddonFromGithubDir, fetchAddonMarketFromTopic, loadCustomAddons, loadDirPlugins, importAddonBundle, importAddonFromZip} from '../lib/ext-addons.js';
import {installVoiceInput} from '../lib/voice-input.js';
import {openAskBar} from '../lib/ai-ask-bar.js';
import {LEGAL_DOCS} from '../lib/legal-docs.js';
import DebuggerPanel from './DebuggerPanel.jsx';
import '../styles/extension-builder.css';

/**
 * Blockly 的媒体资源目录（积木上的小图标、光标、点击音效都从这里取）。
 *
 * 为什么不能像原来那样写死 '/static/blocks-media/default/'：
 * 这是个**绝对路径**，只在站点部署于根路径时成立。GitHub Pages 把项目站点
 * 放在 /<仓库名>/ 子路径下，于是浏览器会去请求
 *     https://<user>.github.io/static/blocks-media/...   → 404
 * 而文件其实在
 *     https://<user>.github.io/<仓库名>/static/blocks-media/...
 * 表现就是工作区里所有 field_image 图标（画笔/音乐/wedo2/microbit 等）全裂开，
 * 而本地 localhost 开发时因为部署在根路径，完全看不出问题。
 *
 * ROOT 由 webpack DefinePlugin 在构建时注入（见 webpack.config.js），
 * 本地开发时为空串，线上构建时是 '/ForgeExt/'（随仓库名而定）。
 */
function blocklyMediaPath() {
    var root = (typeof process !== 'undefined' && process.env && process.env.ROOT) || '/';
    if (root.charAt(root.length - 1) !== '/') root += '/';
    return root + 'static/blocks-media/default/';
}

// 积木预设颜色（Scratch 风格常用色，供积木定义面板选择）
// 第一格是「跟随扩展主题色」：colour 为空时积木实际用 extInfo.color1 渲染，
// 色板必须有一格能表达这个状态，否则 UI 显示的选中色和积木本体对不上
// （曾出现：积木是主题粉色，色板却把紫色框出来，用户以为选错了色）。
const BLOCK_COLOURS = [
    '__THEME__', // 跟随扩展主题色（resolveBlockColour 的空 colour 分支）
    '#FF6680', // 红
    '#FFAB19', // 橙
    '#FFD500', // 黄
    '#59C059', // 绿
    '#0FBD8C', // 青
    '#4C97FF', // 蓝
    '#9966FF', // 紫
    '#A66F48'  // 棕
];

/**
 * For each (block, input_name) we map to the standard block type whose
 * shadow child will be attached as the placeholder. Numbers use
 * math_number, strings use text, booleans use logic_boolean. When a real
 * reporter block is plugged in, Blockly swaps the shadow out automatically.
 */
const PLACEHOLDER_SHADOWS = {
    control_wait:     {TIME: {type: 'math_number', field: 'NUM', value: 1}},
    control_repeat:   {TIMES: {type: 'math_number', field: 'NUM', value: 10}},
    control_return:   {VALUE: {type: 'text', field: 'TEXT', value: ''}},
    control_inlineReturn:{VALUE: {type: 'text', field: 'TEXT', value: ''}},
    math_arithmetic:  {A: {type: 'math_number', field: 'NUM', value: 0}, B: {type: 'math_number', field: 'NUM', value: 0}},
    math_single:      {NUM: {type: 'math_number', field: 'NUM', value: 0}},
    math_round:       {NUM: {type: 'math_number', field: 'NUM', value: 0}},
    math_random:      {FROM: {type: 'math_number', field: 'NUM', value: 1}, TO: {type: 'math_number', field: 'NUM', value: 10}},
    math_trig:        {NUM: {type: 'math_number', field: 'NUM', value: 0}},
    math_compare:     {A: {type: 'math_number', field: 'NUM', value: 0}, B: {type: 'math_number', field: 'NUM', value: 0}},
    string_concat:    {A: {type: 'text', field: 'TEXT', value: ''}, B: {type: 'text', field: 'TEXT', value: ''}},
    string_slice:     {STR: {type: 'text', field: 'TEXT', value: ''}, START: {type: 'math_number', field: 'NUM', value: 0}, END: {type: 'math_number', field: 'NUM', value: 0}},
    string_indexOf:   {STR: {type: 'text', field: 'TEXT', value: ''}, SUBSTR: {type: 'text', field: 'TEXT', value: ''}},
    string_length:    {STR: {type: 'text', field: 'TEXT', value: ''}},
    string_contains:  {STR: {type: 'text', field: 'TEXT', value: ''}, SUBSTR: {type: 'text', field: 'TEXT', value: ''}},
    string_replace:   {STR: {type: 'text', field: 'TEXT', value: ''}, OLD: {type: 'text', field: 'TEXT', value: ''}, NEW: {type: 'text', field: 'TEXT', value: ''}},
    string_trim:      {STR: {type: 'text', field: 'TEXT', value: ''}},
    string_toUpperCase:{STR: {type: 'text', field: 'TEXT', value: ''}},
    string_toLowerCase:{STR: {type: 'text', field: 'TEXT', value: ''}},
    string_regex:     {STR: {type: 'text', field: 'TEXT', value: ''}, PATTERN: {type: 'text', field: 'TEXT', value: ''}},
    vector_create:    {X: {type: 'math_number', field: 'NUM', value: 0}, Y: {type: 'math_number', field: 'NUM', value: 0}},
    var_set:          {VALUE: {type: 'text', field: 'TEXT', value: ''}},
    var_change:       {DELTA: {type: 'math_number', field: 'NUM', value: 0}},
    list_getItem:     {INDEX: {type: 'math_number', field: 'NUM', value: 0}},
    list_indexOf:     {ITEM: {type: 'text', field: 'TEXT', value: ''}},
    list_contains:    {ITEM: {type: 'text', field: 'TEXT', value: ''}},
    list_addItem:     {ITEM: {type: 'text', field: 'TEXT', value: ''}},
    list_removeItem:  {INDEX: {type: 'math_number', field: 'NUM', value: 0}},
    list_replaceItem: {INDEX: {type: 'math_number', field: 'NUM', value: 0}, ITEM: {type: 'text', field: 'TEXT', value: ''}},
    func_return:      {VALUE: {type: 'text', field: 'TEXT', value: ''}},
    block_field_number:{DEFAULT: {type: 'math_number', field: 'NUM', value: 0}},
    browser_alert:    {MSG: {type: 'text', field: 'TEXT', value: ''}},
    browser_console:  {MSG: {type: 'text', field: 'TEXT', value: ''}},
    browser_localStorageSet:{VALUE: {type: 'text', field: 'TEXT', value: ''}},
    browser_openUrl:  {URL: {type: 'text', field: 'TEXT', value: ''}},
    music_playTone:   {FREQ: {type: 'math_number', field: 'NUM', value: 440}, TIME: {type: 'math_number', field: 'NUM', value: 1}},
    music_playNote:   {BEATS: {type: 'math_number', field: 'NUM', value: 1}},
    music_rest:       {BEATS: {type: 'math_number', field: 'NUM', value: 1}},
    music_setVolume:  {VOLUME: {type: 'math_number', field: 'NUM', value: 50}},
    music_setTempo:   {TEMPO: {type: 'math_number', field: 'NUM', value: 120}},
    event_whenTimerGreaterThan: {VALUE: {type: 'math_number', field: 'NUM', value: 10}},
    event_whenLoudnessGreaterThan: {VALUE: {type: 'math_number', field: 'NUM', value: 10}},
    motion_moveSteps: {STEPS: {type: 'math_number', field: 'NUM', value: 10}},
    motion_turnRight: {DEGREES: {type: 'math_number', field: 'NUM', value: 15}},
    motion_turnLeft: {DEGREES: {type: 'math_number', field: 'NUM', value: 15}},
    motion_pointInDirection: {DIRECTION: {type: 'math_number', field: 'NUM', value: 90}},
    motion_glideTo: {SECS: {type: 'math_number', field: 'NUM', value: 1}, X: {type: 'math_number', field: 'NUM', value: 0}, Y: {type: 'math_number', field: 'NUM', value: 0}},
    looks_say: {MESSAGE: {type: 'text', field: 'TEXT', value: '你好!'}, SECS: {type: 'math_number', field: 'NUM', value: 2}},
    looks_think: {MESSAGE: {type: 'text', field: 'TEXT', value: '嗯...'}},
    looks_changeSize: {CHANGE: {type: 'math_number', field: 'NUM', value: 10}},
    net_httpGet: {URL: {type: 'text', field: 'TEXT', value: 'https://example.com/api'}},
    net_httpPost: {URL: {type: 'text', field: 'TEXT', value: 'https://example.com/api'}, BODY: {type: 'text', field: 'TEXT', value: '{}'}},
    net_jsonParse: {JSON: {type: 'text', field: 'TEXT', value: '{"a":1}'}, KEY: {type: 'text', field: 'TEXT', value: 'a'}},
    time_waitMs: {MS: {type: 'math_number', field: 'NUM', value: 1000}}
};

const DEFAULT_EXTENSION_INFO = {
    id: 'myextension',
    name: '我的第一个扩展',
    description: '',
    author: '',
    docsUrl: '',
    license: 'MPL-2.0',
    color1: '#FF6680',
    color2: '#FF4D6A',
    color3: '#FF3355',
    categoryIcon: '',
    blockIcon: '',
    customId: false,
    blocks: []
};

// Common open-source licenses for Scratch extensions
const LICENSE_OPTIONS = [
    'MPL-2.0',
    'MIT',
    'Apache-2.0',
    'GPL-3.0',
    'BSD-3-Clause',
    'CC-BY-4.0',
    'CC0-1.0',
    'Proprietary'
];

const COLOR_PRESETS = [
    ['#FF6680', '#FF4D6A', '#FF3355'],
    ['#4C97FF', '#4280D7', '#3373CC'],
    ['#9966FF', '#855CD6', '#774DCB'],
    ['#0FBD8C', '#0DA57A', '#0B8E69'],
    ['#FF8C1A', '#FF8000', '#DB6E00'],
    ['#FFBF00', '#E6AC00', '#CC9900'],
    ['#5CB1D7', '#4A9DC0', '#3D8AA8'],
    ['#CF63CF', '#BB4FBC', '#A53EA5']
];

// Error boundary to catch rendering errors
class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = {error: null};
    }
    static getDerivedStateFromError(error) {
        return {error};
    }
    componentDidCatch(error, info) {
        console.error('ExtensionBuilder error:', error, info);
    }
    render() {
        if (this.state.error) {
            return (
                <div className="ext-builder-error">
                    <h2>运行时错误</h2>
                    <pre style={{whiteSpace: 'pre-wrap', maxWidth: '80%', overflow: 'auto'}}>
                        {this.state.error.toString()}
                    </pre>
                    <button onClick={() => window.location.reload()}>刷新页面</button>
            </div>
            );
        }
        return this.props.children;
    }
}

const ExtensionBuilder = () => {
    return (
        <ErrorBoundary>
            <ExtensionBuilderInner />
        </ErrorBoundary>
    );
};

const ExtensionBuilderInner = () => {
    const blocklyDivRef = useRef(null);
    const workspaceRef = useRef(null);
    const [generatedCode, setGeneratedCode] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [showBlockBuilder, setShowBlockBuilder] = useState(false);
    const [builderModalPos, setBuilderModalPos] = useState(null); // {x, y}
    const builderModalRef = useRef(null);
    const builderResizeRef = useRef(null); // {dir, startX, startY, origLeft, origTop, origWidth, origHeight}
    const [builderMinimized, setBuilderMinimized] = useState(false);
    const [builderMaximized, setBuilderMaximized] = useState(false);
    const [builderSize, setBuilderSize] = useState(null); // {width, height}
    const BUILDER_RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const builderDragRef = useRef(null); // {startX, startY, origX, origY}
    // Blockly workspace XML is stored in a ref instead of React state so
    // that drag operations don't trigger component re-renders (which
    // were causing the floating builder window's block list to flash /
    // disappear during drags).
    const customBlockXmlRef = useRef(new Map());

    // 制作积木浮窗的开关副作用：Esc 关闭 + 主动刷新 Blockly 视口。
    //
    // 为什么要刷新视口：浮窗虽是 position:fixed 独立层，但它的挂载/卸载
    // 会让浏览器重排；而 Blockly 的 SVG 尺寸、toolbox 宽度、flyout 的
    // clipPath 全是缓存值，收不到 resize 就不重算。表现为打开浮窗后左侧
    // 积木工具箱 / flyout 被裁切甚至整块看不见。这里在开关后的 0/120/400ms
    // 各补一次 svgResize（覆盖 React 提交、字体、滚动条出现的时序差）。
    useEffect(() => {
        const refreshBlockly = () => {
            const ws = workspaceRef.current;
            const B = window._extBuilderBlockly || window.Blockly;
            if (ws && B && typeof B.svgResize === 'function') {
                try { B.svgResize(ws); } catch (e) { /* 忽略 */ }
            }
        };
        const timers = [0, 120, 400].map((ms) => setTimeout(refreshBlockly, ms));
        const clearTimers = () => timers.forEach((t) => clearTimeout(t));

        if (!showBlockBuilder) {
            // 关闭时也要刷一次，把工作区从「被浮窗挤压/裁切」的状态恢复。
            return clearTimers;
        }
        const onKey = (e) => {
            if (e.key === 'Escape') setShowBlockBuilder(false);
        };
        document.addEventListener('keydown', onKey);
        return () => {
            clearTimers();
            document.removeEventListener('keydown', onKey);
        };
    }, [showBlockBuilder]);

    // Drag the floating builder window by its header.
    const handleBuilderDragStart = useCallback((e) => {
        if (e.button !== 0 || !builderModalRef.current) return;
        const rect = builderModalRef.current.getBoundingClientRect();
        builderDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origX: rect.left,
            origY: rect.top
        };
        document.addEventListener('mousemove', handleBuilderDragMove);
        document.addEventListener('mouseup', handleBuilderDragEnd);
        e.preventDefault();
    }, []);

    const handleBuilderDragMove = useCallback((e) => {
        if (!builderDragRef.current) return;
        const dx = e.clientX - builderDragRef.current.startX;
        const dy = e.clientY - builderDragRef.current.startY;
        setBuilderModalPos({
            x: builderDragRef.current.origX + dx,
            y: builderDragRef.current.origY + dy
        });
    }, []);

    const handleBuilderDragEnd = useCallback(() => {
        builderDragRef.current = null;
        document.removeEventListener('mousemove', handleBuilderDragMove);
        document.removeEventListener('mouseup', handleBuilderDragEnd);
    }, [handleBuilderDragMove]);

    // Minimize / maximize the builder window (matches realtime-collab behaviour).
    const handleBuilderMinimize = useCallback(() => {
        setBuilderMinimized((prev) => !prev);
    }, []);

    const handleBuilderMaximize = useCallback(() => {
        setBuilderMaximized((prev) => {
            const next = !prev;
            // Toggle overflow:hidden on parent chain so the fixed modal isn't clipped
            const modal = builderModalRef.current;
            if (modal) {
                let el = modal.parentElement;
                while (el && el !== document.documentElement) {
                    el.style.overflow = next ? 'visible' : '';
                    el = el.parentElement;
                }
            }
            return next;
        });
    }, []);

    // 8-direction resize, driven by the edge/corner handles.
    const handleBuilderResizeMove = useCallback((e) => {
        const st = builderResizeRef.current;
        if (!st) return;
        const dx = e.clientX - st.startX;
        const dy = e.clientY - st.startY;
        const MIN_W = 300;
        const MIN_H = 360;
        let left = st.origLeft;
        let top = st.origTop;
        let width = st.origWidth;
        let height = st.origHeight;
        if (st.dir.indexOf('e') !== -1) width = Math.max(MIN_W, st.origWidth + dx);
        if (st.dir.indexOf('s') !== -1) height = Math.max(MIN_H, st.origHeight + dy);
        if (st.dir.indexOf('w') !== -1) {
            width = Math.max(MIN_W, st.origWidth - dx);
            left = st.origLeft + (st.origWidth - width);
        }
        if (st.dir.indexOf('n') !== -1) {
            height = Math.max(MIN_H, st.origHeight - dy);
            top = st.origTop + (st.origHeight - height);
        }
        setBuilderModalPos({ x: Math.round(left), y: Math.round(top) });
        setBuilderSize({ width: Math.round(width), height: Math.round(height) });
    }, []);

    const handleBuilderResizeEnd = useCallback(() => {
        builderResizeRef.current = null;
        document.removeEventListener('mousemove', handleBuilderResizeMove);
        document.removeEventListener('mouseup', handleBuilderResizeEnd);
    }, [handleBuilderResizeMove]);

    const handleBuilderResizeStart = useCallback((e, dir) => {
        if (e.button !== 0 || !builderModalRef.current) return;
        const rect = builderModalRef.current.getBoundingClientRect();
        builderResizeRef.current = {
            dir,
            startX: e.clientX,
            startY: e.clientY,
            origLeft: rect.left,
            origTop: rect.top,
            origWidth: rect.width,
            origHeight: rect.height
        };
        document.addEventListener('mousemove', handleBuilderResizeMove);
        document.addEventListener('mouseup', handleBuilderResizeEnd);
        e.preventDefault();
        e.stopPropagation();
    }, [handleBuilderResizeMove, handleBuilderResizeEnd]);
    const [searchTerm, setSearchTerm] = useState('');
    const [extInfo, setExtInfo] = useState(DEFAULT_EXTENSION_INFO);
    // extInfo.color1 的实时镜像：供 addStarterBlocks 等普通函数路径读取，
    // 避免每个调用点都要把 extInfo.color1 加进依赖数组（漏加会让颜色过期）。
    const extColor1Ref = useRef(DEFAULT_EXTENSION_INFO.color1);
    extColor1Ref.current = extInfo.color1 || DEFAULT_EXTENSION_INFO.color1;
    const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
    const [editingBlockId, setEditingBlockId] = useState(null);
    const [editingName, setEditingName] = useState('');
    const [settingsDraft, setSettingsDraft] = useState(null);
    const [showBlockPreview, setShowBlockPreview] = useState(false);
    // AI 询问条（对齐 DeepSeek Harness 的 ask_user_question）：贴在 AI 面板的
    // 提示词输入框上方，一次可以问多个问题。句柄存在 ref 里而不是 state ——
    // 它是 lib/ai-ask-bar.js 里的原生 DOM 组件，不参与 React 渲染。
    const aiAskBarRef = useRef(null);

    // ---- 登录 / 存档 / 跨站同步 ----
    const [session, setSession] = useState(() => getSession());
    // 登录方式只有一种：GitHub Device Flow。全程在编辑器页面内完成，
    // 不跳 scratchextensioneditor.cc.cd，也不依赖任何第三方中转站。
    // 用户名/密码、邮箱验证码、Turnstile 那套本地账号体系已下线。
    // deviceFlow 描述当前授权进度；null 表示没有登录流程在跑。
    //   status: 'starting' | 'waiting' | 'error'
    const [deviceFlow, setDeviceFlow] = useState(null);
    const deviceFlowTimerRef = useRef(null);
    const deviceFlowBusyRef = useRef(false);
    // PAT 粘贴登录（线上主登录方式）。
    // 线上是 GitHub Pages：无法代理 Device Flow 的 POST（纯静态挡 POST、
    // github.com OAuth 端点无 CORS），Device Flow 只在本地 devServer 下可用。
    // PAT 走 api.github.com（自带 CORS），无服务端依赖。
    const [patLogin, setPatLogin] = useState({busy: false, error: '', showForm: false});
    const patInputRef = useRef(null);
    // 条款弹窗：null | 'terms' | 'privacy'。正文在 lib/legal-docs.js，
    // 与网站上的条款页内容一致；这里只决定显示哪一篇。
    const [legalModal, setLegalModal] = useState(null);
    // 是否已同意条款。默认 false（沉默不等于同意）：未同意时点「GitHub 登录」
    // 会先弹条款窗，同意后才真正发起 Device Flow。
    const [legalAgreed, setLegalAgreed] = useState(false);
    // 用户是在「准备登录」时被条款拦下的：同意后应自动继续登录，
    // 否则他得再点一次「GitHub 登录」。
    const pendingLoginRef = useRef(false);
    const [prevSession, setPrevSession] = useState(() => getPrevSession()); // 切换账号时记住的上一个会话
    const [showAccountSwitcher, setShowAccountSwitcher] = useState(false); // 多账号切换子菜单
    const [accountList, setAccountList] = useState(() => getRegisteredAccounts()); // 已注册账号列表
    const [showSavesPanel, setShowSavesPanel] = useState(false);
    const [savesList, setSavesList] = useState([]);
    const [saveNameInput, setSaveNameInput] = useState('');
    const [saveMsg, setSaveMsg] = useState('');
    const [syncLinkText, setSyncLinkText] = useState('');
    const [syncInput, setSyncInput] = useState('');

    // ExtAddons 插件系统：弹窗开关 + 激活清理
    const [showAddonsPanel, setShowAddonsPanel] = useState(false);
    const [addonState, setAddonStateInternal] = useState(() => getAddonState());
    const [addonSearch, setAddonSearch] = useState('');
    /**
     * 插件列表的刷新计数器。
     *
     * getAllAddons() 读的是 ext-addons.js 里的模块级数组（_dirPlugins），
     * 不是 React state —— 删除一个目录插件后，模块级数据变了，但 React
     * 不知道要重渲染，列表里那一行会赖着不走。改这个计数器来强制刷新。
     */
    const [addonListVersion, setAddonListVersion] = useState(0);
    // 列表数据来自模块级数组，不是 state，所以用 useMemo 显式依赖上面的计数器，
    // 让「删除后重新拉清单」能真正反映到界面上。
    const addonList = useMemo(() => getAllAddons(), [addonListVersion]);
    // 安装插件对话框（对齐 DSH 的 dsh plugin add）
    const [showInstallModal, setShowInstallModal] = useState(false);
    const [installSource, setInstallSource] = useState('');
    const [installStatus, setInstallStatus] = useState('');
    const [installError, setInstallError] = useState('');
    const [installLoading, setInstallLoading] = useState(false);
    const [installLog, setInstallLog] = useState([]);
    const installPanelRef = useRef(null);
    const installDragRef = useRef(null);
    const [installFloatBounds, setInstallFloatBounds] = useState({ x: 300, y: 150, w: 560, h: 440 });
    const [installMinimized, setInstallMinimized] = useState(false);
    const [installMaximized, setInstallMaximized] = useState(false);

    // ─── 全局 z-index 层级管理（基准 1000000，高于所有旧的固定 z-index） ───
    const Z_BASE = 1000000;
    const [panelZIndexes, setPanelZIndexes] = useState({
        builder: Z_BASE, settings: Z_BASE, user: Z_BASE, stats: Z_BASE, install: Z_BASE, rtc: Z_BASE, nova: Z_BASE, debugger: Z_BASE
    });
    const zCounterRef = useRef(Z_BASE);
    const bringToFront = useCallback((panelId) => {
        zCounterRef.current += 1;
        const newZ = zCounterRef.current;
        setPanelZIndexes(prev => {
            const next = {};
            Object.keys(prev).forEach(k => {
                next[k] = k === panelId ? newZ : Math.max(Z_BASE - 1000, prev[k] - 1);
            });
            return next;
        });
    }, []);
    const getZIndex = useCallback((panelId) => panelZIndexes[panelId] || Z_BASE, [panelZIndexes]);

    // 桥接：供纯 JS 面板（实时协作）调用置顶
    useEffect(() => {
        window.__extBringToFront = bringToFront;
        return () => { delete window.__extBringToFront; };
    }, [bringToFront]);

    // 把 rtc / nova（bilup AI）面板的层级同步到其真实 DOM（这些面板不在 React 树内）
    useEffect(() => {
        const rtc = document.querySelector('.rtc-panel');
        if (rtc) rtc.style.zIndex = String(panelZIndexes.rtc);
        document.querySelectorAll('.sa-nova-wm-root').forEach(el => {
            el.style.zIndex = String(panelZIndexes.nova);
        });
    }, [panelZIndexes]);

    // AI 面板语音输入（SenseVoice 本地识别）：注入麦克风按钮
    useEffect(() => {
        installVoiceInput();
    }, []);
    const installFileRef = useRef(null);
    // 统一设置面板（含扩展设置 + 插件管理标签页）
    const [showSettingsPanel, setShowSettingsPanel] = useState(false);
    const [settingsTab, setSettingsTab] = useState('editor'); // 'editor' | 'addons'
    const settingsPanelRef = useRef(null); // 设置悬浮框 DOM 引用
    const [settingsMinimized, setSettingsMinimized] = useState(false); // 是否最小化
    const [settingsMaximized, setSettingsMaximized] = useState(false); // 是否最大化
    const settingsBoundsRef = useRef(null); // 最大化前保存的位置尺寸
    const [settingsResizeLayerOn, setSettingsResizeLayerOn] = useState(false); // resize 层显隐
    const [addonOpts, setAddonOptsInternal] = useState(() => {
        // 初始化所有有 options 的插件的子选项状态
        const opts = {};
        getAllAddons().filter(a => a.options && a.options.length).forEach(a => {
            opts[a.id] = getAddonOptions(a.id, a.options);
        });
        return opts;
    });
    // 插件市场（从 GitHub 仓库清单加载可安装插件）
    const [marketView, setMarketView] = useState(false); // 是否在插件管理内显示市场
    const [marketList, setMarketList] = useState([]);
    const [marketLoading, setMarketLoading] = useState(false);
    const [marketError, setMarketError] = useState('');
    const [marketInstalled, setMarketInstalled] = useState({}); // { dir: true }
    const [marketInstalling, setMarketInstalling] = useState(''); // 正在安装的 dir
    const MARKET_TOPIC = 'extforge-addon'; // 插件市场主题标签（github.com/topics/...）
    const extAddonsCleanupRef = useRef(null);

    // 个人主页
    const [showProfilePanel, setShowProfilePanel] = useState(false);
    const [profileMeta, setProfileMeta] = useState(null);
    const [profileCounts, setProfileCounts] = useState({following: 0, followers: 0});

    // 好友 / 关注
    const [showFriendsPanel, setShowFriendsPanel] = useState(false);
    const [friendsTab, setFriendsTab] = useState('friends'); // 'friends' | 'following' | 'followers'
    const [friendsRelations, setFriendsRelations] = useState([]); // [{follower, followee}]

    // 用户下拉菜单
    const [showUserMenu, setShowUserMenu] = useState(false);
    const [showToolsMenu, setShowToolsMenu] = useState(false);
    const [showFileMenu, setShowFileMenu] = useState(false);
    const [showEditMenu, setShowEditMenu] = useState(false);
    const [showStatsPanel, setShowStatsPanel] = useState(false);
    const statsPanelRef = useRef(null);
    const statsResizeLayerRef = useRef(null);
    const [statsFloatBounds, setStatsFloatBounds] = useState({ x: 200, y: 100, w: 560, h: 480 });
    const [statsMinimized, setStatsMinimized] = useState(false);
    const [statsMaximized, setStatsMaximized] = useState(false);
    const statsSavedBounds = useRef(null);
    const statsDragRef = useRef(null);
    const statsResizeRef = useRef(null);
    const [statsTick, setStatsTick] = useState(0); // 强制 projectStats 重算的计数器

    // ─── 调试器悬浮框状态（与设置面板同一套交互：拖动 / 拉伸 / 最大化 / 最小化 / 关闭）───
    // 说明：调试器不再占用右侧固定栏，而是像设置面板一样浮在工作区之上，
    // 因为它的内容是「打开在线编辑器」，用户往往需要一边看工作区一边点。
    const [showDebuggerPanel, setShowDebuggerPanel] = useState(false);
    const debuggerPanelRef = useRef(null);
    const debuggerResizeLayerRef = useRef(null);
    const [debuggerFloatBounds, setDebuggerFloatBounds] = useState({ x: 260, y: 90, w: 420, h: 520 });
    const [debuggerMinimized, setDebuggerMinimized] = useState(false);
    const [debuggerMaximized, setDebuggerMaximized] = useState(false);
    const debuggerSavedBounds = useRef(null);
    const debuggerDragRef = useRef(null);
    const debuggerResizeRef = useRef(null);

    // 用户面板悬浮框状态（个人主页/好友/存档共用一套，同时只开一个）
    const [userPanelType, setUserPanelType] = useState(null); // 'profile' | 'friends' | 'saves'
    const userFloatRef = useRef(null);
    const [userFloatBounds, setUserFloatBounds] = useState({ x: 120, y: 70, w: 520, h: 520 });
    const [userMaximized, setUserMaximized] = useState(false);
    const [userMinimized, setUserMinimized] = useState(false);
    const [userResizeLayerOn, setUserResizeLayerOn] = useState(false);
    const userFloatSavedBounds = useRef(null);
    const [friendsSearch, setFriendsSearch] = useState('');
    const [friendsResults, setFriendsResults] = useState([]);
    const [friendsBusy, setFriendsBusy] = useState(false);
    const [friendsMsg, setFriendsMsg] = useState('');

    // Block management state (like Scratch's sprite list)
    const [customBlocks, setCustomBlocks] = useState([
        {
            id: 'block_1', name: '我的第一个积木', xml: null,
            blockType: 'command', isTerminal: false, isAsync: false,
            attachAllThreads: false, filterSprite: true, filterStage: true, icon: '',
            colour: ''
        },
        {
            id: 'block_2', name: '我的第二个积木', xml: null,
            blockType: 'command', isTerminal: false, isAsync: false,
            attachAllThreads: false, filterSprite: true, filterStage: true, icon: '',
            colour: ''
        },
        {
            id: 'block_3', name: '我的第三个积木', xml: null,
            blockType: 'command', isTerminal: false, isAsync: false,
            attachAllThreads: false, filterSprite: true, filterStage: true, icon: '',
            colour: ''
        }
    ]);
    // 派生：代码面板显示的内容 = 与导出 .js 文件完全一致（wrapAsExtension 输出）。
    // 放这里是为了确保 generatedCode / extInfo / customBlocks 都已声明（避免 TDZ）。
    const exportableCode = React.useMemo(() => {
        if (!generatedCode && !(customBlocks && customBlocks.length)) return '';
        try {
            return wrapAsExtension(extInfo, generatedCode, customBlocks);
        } catch (e) {
            return '// 包装失败：' + (e && e.message ? e.message : String(e)) +
                '\n\n/* 原始生成代码 */\n' + generatedCode;
        }
    }, [extInfo, generatedCode, customBlocks]);

    // ── 项目统计数据（积木数、代码大小、复杂度等）──
    const projectStats = useMemo(() => {
        // 优先统计工作区中实际放置的积木数量，回退到定义数量
        let workspaceBlockCount = 0;
        let wsHat = 0, wsCmd = 0, wsReporter = 0, wsBool = 0;
        try {
            const ws = workspaceRef.current;
            if (ws) {
                const allBlocks = ws.getAllBlocks ? ws.getAllBlocks() : [];
                // 过滤掉 shadow 积木（placeholder）和 disabled 积木
                const realBlocks = allBlocks.filter(b => !b.isShadow() && !b.disabled);
                workspaceBlockCount = realBlocks.length;
                realBlocks.forEach(b => {
                    const opcode = b.type || '';
                    // 从 opcode 或输出连接判断类型
                    if (b.outputConnection) {
                        if (b.outputConnection.check_ && b.outputConnection.check_.includes('Boolean')) wsBool++;
                        else wsReporter++;
                    } else if (b.previousConnection === null && b.nextConnection !== null) {
                        wsHat++;
                    } else {
                        wsCmd++;
                    }
                });
            }
        } catch(e) { /* workspace 未就绪 */ }

        // 如果工作区没有积木，回退到定义数量
        const blockCount = workspaceBlockCount > 0 ? workspaceBlockCount : (customBlocks || []).length;

        // 使用 exportableCode（代码面板实际显示的完整包装后代码）
        const code = exportableCode || generatedCode || '';
        const codeSize = new Blob([code], { type: 'text/javascript' }).size;
        const fullSize = codeSize; // exportableCode 已经是完整导出代码
        const lineCount = code.split('\n').length;

        // 如果工作区有统计则使用，否则从定义推断
        const hatCount = workspaceBlockCount > 0 ? wsHat : (customBlocks || []).filter(b => b.blockType === 'hat').length;
        const cmdCount = workspaceBlockCount > 0 ? wsCmd : (customBlocks || []).filter(b => b.blockType === 'command' || !b.blockType).length;
        const reporterCount = workspaceBlockCount > 0 ? wsReporter : (customBlocks || []).filter(b => b.blockType === 'reporter').length;
        const boolCount = workspaceBlockCount > 0 ? wsBool : (customBlocks || []).filter(b => b.blockType === 'boolean').length;

        // 复杂度评分（极高考门槛：至少约3000块积木才能取得高分）
        // 积木分（上限70分）：每块0.024分，需约2900块才满
        const blockScore = Math.min(70, blockCount * 0.024);
        // 代码行数分（上限18分）：每行0.036分，需约500行才满（辅助项）
        const lineScore = Math.min(18, lineCount * 0.036);
        // 类型多样性分（上限12分）
        const typeDiversity = Math.min(12, (hatCount + cmdCount + reporterCount + boolCount) * 1.0);
        const complexityScore = Math.round(blockScore + lineScore + typeDiversity);
        const complexityLevel = complexityScore < 15 ? '低' : complexityScore < 35 ? '中' : complexityScore < 55 ? '较高' : complexityScore < 78 ? '高' : '极高';
        return { blockCount, codeSize, fullSize, lineCount, hatCount, cmdCount, reporterCount, boolCount, complexityScore, complexityLevel };
    }, [customBlocks, generatedCode, exportableCode, workspaceLoaded, statsTick]);

    const [copyMsg, setCopyMsg] = useState('');
    const copyMsgTimerRef = useRef(null);
    const [currentBlockId, setCurrentBlockId] = useState('block_1');
    const currentBlockRef = useRef('block_1');
    // Keep a ref to quickly save current workspace without re-render
    const saveWorkspaceRef = useRef(() => {});

    // Load scratch-blocks
    useEffect(() => {
        let cancelled = false;
        try {
            if (LazyScratchBlocks.isLoaded()) {
                setLoaded(true);
                return;
            }
            LazyScratchBlocks.load()
                .then((BlocklyModule) => {
                    if (cancelled) return;
                    // BlocklyModule is the scratch-blocks default export (the Blockly global)
                    const Blockly = BlocklyModule && (BlocklyModule.default || BlocklyModule);
                    console.log('scratch-blocks loaded. Blockly:', typeof Blockly);
                    console.log('Blockly.inject:', typeof (Blockly && Blockly.inject));
                    console.log('Blockly.Blocks:', typeof (Blockly && Blockly.Blocks));
                    // Make sure window.Blockly also has the right reference
                    if (Blockly && typeof Blockly.inject === 'function') {
                        window.Blockly = Blockly;
                    }
                    setLoaded(true);
                })
                .catch(err => {
                    console.error('Failed to load scratch-blocks:', err);
                    if (!cancelled) {
                        setLoadError(err.message || String(err));
                        setLoaded(true);
                    }
                });
        } catch (e) {
            console.error('LazyScratchBlocks error:', e);
            setLoadError(e.message);
            setLoaded(true);
        }
        return () => { cancelled = true; };
    }, []);

    // Initialize Blockly workspace
    useEffect(() => {
        if (!loaded || workspaceLoaded || !blocklyDivRef.current) return;

        try {
            // Try multiple sources to get Blockly
            let Blockly = null;
            if (LazyScratchBlocks.get) {
                Blockly = LazyScratchBlocks.get();
            }
            if (!Blockly && window.Blockly && typeof window.Blockly.inject === 'function') {
                Blockly = window.Blockly;
            }

            if (!Blockly || typeof Blockly.inject !== 'function') {
                console.error('Blockly not properly loaded', {
                    fromLazy: typeof (LazyScratchBlocks.get && LazyScratchBlocks.get()),
                    fromWindow: typeof window.Blockly,
                    windowKeys: window.Blockly ? Object.keys(window.Blockly).slice(0, 20) : []
                });
                setLoadError('Blockly.inject function not available. Check browser console.');
                return;
            }

            // Set Blockly media path to local scratch-blocks media (avoid blockly-demo.appspot.com requests)
            if (Blockly.utils && typeof Blockly.utils._MEDIA_URL !== 'undefined') {
                Blockly.utils._MEDIA_URL = blocklyMediaPath();
            }

            // Register all custom blocks
            let registeredCount = 0;
            Object.entries(BLOCK_DEFINITIONS).forEach(([type, def]) => {
                if (!Blockly.Blocks) {
                    console.warn('Blockly.Blocks not found, creating empty object');
                    Blockly.Blocks = {};
                }
                // Register all custom blocks (override any built-in Scratch
                // blocks with the same type — e.g. event_broadcast,
                // control_wait — so custom shapes apply).
                if (Blockly.Blocks[type]) {
                    Blockly.Blocks[type] = null; // force re-init with custom def
                }
                // Clean the definition: remove type (set externally), keep everything else
                const cleanDef = {};
                Object.keys(def).forEach(k => {
                    if (k !== 'type') cleanDef[k] = def[k];
                });
                Blockly.Blocks[type] = {
                    init: function () {
                        // Apply hat shape for HAT blocks before jsonInit, so SVG renders
                        // the curved top instead of a flat one. scratch-blocks detects
                        // this via the `shape_hat` extension which calls setInputsInline
                        // + setNextStatement + sets `this.hat_ = true`. We must also
                        // REMOVE the previousStatement field — otherwise Blockly's
                        // jsonInit treats `previousStatement: null` as "create a
                        // previousConnection of any type", which gives the block a
                        // flat top with a notch instead of a curved hat top.
                        if (cleanDef.id === 'HAT') {
                            delete cleanDef.previousStatement;
                            const baseExts = (def.extensions || []).filter(function (e) { return e !== 'shape_hat'; });
                            cleanDef.extensions = baseExts.concat(['shape_hat']);
                            // block_define uses the same yellow as other hat blocks
                            // (scratch event category) so it looks identical.
                            if (type === 'block_define') {
                                cleanDef.colour = 45;
                            }
                        }
                        // Use jsonInit for all output shape decisions.
                        // This avoids infinite recursion that occurs when
                        // calling setOutput + jsonInit separately.
                        this.jsonInit(cleanDef);
                        // After jsonInit, override the bottom notch for block_define.
                        // shape_hat extension sets setNextStatement(true) which
                        // creates a C-shape notch at the bottom. Remove it so
                        // block_define looks like an ordinary hat block (flat
                        // bottom, no C notch) — matching CB-ExtGallary / scratch
                        // standard hat appearance.
                        if (type === 'block_define') {
                            this.setNextStatement(false);
                        }
                        // After jsonInit, set the output shape if applicable.
                        if (this.outputConnection) {
                            let outputShape = null;
                            if (cleanDef.output === 'Boolean') {
                                outputShape = 1;
                            } else if (cleanDef.output === 'Number' ||
                                       cleanDef.output === 'String') {
                                outputShape = 2;
                            }
                            if (outputShape !== null) {
                                this.setOutputShape(outputShape);
                            }
                        }

                        // For blocks that show a value preview below
                        // (boolean/return blocks), wrap the VALUE field text
                        // with a white background rect that mirrors the
                        // runtime preview in TurboWarp.
                        const previewTypes = ['logic_boolean', 'control_return',
                            'control_inlineReturn', 'func_return'];
                        if (previewTypes.indexOf(type) >= 0) {
                            const valueField = this.getField('VALUE');
                            if (valueField) {
                                valueField.extNeedsBox_ = true;
                                this.extValueField_ = valueField;
                            }
                        }

                        // NOTE: Editable input placeholders are injected via the toolbox
                        // XML as shadow child blocks (<shadow type="math_number">).
                        // Blockly's flyout automatically clones these onto every
                        // block created from the toolbox. For blocks created
                        // programmatically via ws.newBlock(), we attach the
                        // same shadow children here so the visual style is
                        // consistent everywhere.
                        const shadowSpec = PLACEHOLDER_SHADOWS[type];
                        if (shadowSpec && this.workspace) {
                            Object.keys(shadowSpec).forEach((iname) => {
                                const spec = shadowSpec[iname];
                                const input = this.getInput(iname);
                                if (!input || !input.connection) return;
                                if (input.connection.targetBlock()) return;
                                try {
                                    const shadow = this.workspace.newBlock(spec.type);
                                    shadow.setShadow(true);
                                    shadow.setFieldValue(String(spec.value), spec.field);
                                    shadow.initSvg();
                                    shadow.render();
                                    input.connection.connect(shadow.outputConnection);
                                } catch (e) {
                                    // ignore — likely shadow already exists from toolbox
                                }
                            });
                        }
                    }
                };
                registeredCount++;
            });
            console.log('[ExtBuilder] Registered', registeredCount, 'custom blocks');

            // Verify a sample block was created correctly
            const sampleBlock = Blockly.Blocks['event_whenLoaded'];
            if (!sampleBlock) {
                console.error('event_whenLoaded block NOT registered!');
                setLoadError('Block registration failed - no blocks registered');
                return;
            }

            // Set Blockly media path and utils before injection
            if (!Blockly.utils) {
                Blockly.utils = {};
            }
            if (typeof Blockly.utils._MEDIA_URL !== 'string') {
                Blockly.utils._MEDIA_URL = blocklyMediaPath();
            }
            // Initialize xml namespace if missing
            if (!Blockly.utils.xml) {
                Blockly.utils.xml = {};
            }
            if (typeof DOMParser !== 'undefined' && !Blockly.utils.xml.DOM_PARSER) {
                Blockly.utils.xml.DOM_PARSER = new DOMParser();
            }

            // Build multi-category toolbox XML from TOOLBOX_CONFIG (16 categories).
            // Each category shows its own block types from block-definitions.js.
            // The "id" attribute is critical: scratch-blocks uses it for the
            // category menu dots (scratchCategoryId-{id}), so clicking a dot
            // scrolls the flyout to the correct category section.
            const categoryIds = [
                'events', 'control', 'math', 'strings', 'vectors',
                'input', 'variables', 'lists', 'functions', 'blocks',
                'runtime', 'targets', 'browser', 'music', 'script', 'extra'
            ];
            const toolboxXml = '<xml xmlns="https://developers.google.com/blockly/xml">' +
                TOOLBOX_CONFIG.contents.map((cat, idx) => {
                    const childXml = cat.contents.map(b => {
                        const shadows = PLACEHOLDER_SHADOWS[b.type];
                        if (!shadows) return `<block type="${b.type}"/>`;
                        const valueXml = Object.keys(shadows).map(name => {
                            const s = shadows[name];
                            return `<value name="${name}"><shadow type="${s.type}"><field name="${s.field}">${s.value}</field></shadow></value>`;
                        }).join('');
                        return `<block type="${b.type}">${valueXml}</block>`;
                    }).join('');
                    const safeName = String(cat.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const safeColour = String(cat.colour || '#FF6680').replace(/[^#0-9a-fA-F]/g, '');
                    const catId = categoryIds[idx] || 'cat' + idx;
                    return `<category name="${safeName}" id="${catId}" colour="${safeColour}" secondaryColour="${safeColour}">${childXml}</category>`;
                }).join('') +
                '</xml>';
            console.log('[ExtBuilder] Toolbox XML length:', toolboxXml.length);

            // Apply Chinese translations BEFORE inject so Blockly renders blocks
            // with Chinese text from the start (instead of waiting for DOM mutations)
            applyZhTranslations(Blockly);
            console.log('[ExtBuilder] Chinese translations applied to Blockly.Msg');

            // Inject workspace with our custom toolbox. scratch-blocks' default
            // toolbox has 10 categories — we replace it with a SINGLE 自制积木
            // category matching CB-ExtGallary layout.
            const workspace = Blockly.inject(blocklyDivRef.current, {
                toolbox: toolboxXml,
                media: blocklyMediaPath(),
                grid: {
                    spacing: 25,
                    length: 3,
                    // 网格点随顶层底色走：顶层改浅蓝后，灰点会显脏，
                    // 改成同色系蓝灰（比底色深一档，保持可辨识）
                    colour: '#c9d9ee',
                    snap: false
                },
                zoom: {
                    controls: true,
                    wheel: true,
                    startScale: 0.55,
                    maxScale: 3,
                    minScale: 0.3,
                    scaleSpeed: 1.1
                },
                trashcan: true,
                sounds: false,
                // 禁用"折叠所有积木/展开所有积木"右键菜单项，避免
                // scratch-blocks 因 Blockly.Msg.COLLAPSE_ALL/EXPAND_ALL 未
                // 定义而渲染出空白按钮（点击后会把自定义积木塌缩成
                // 小图标，用户很容易误以为是 bug）。
                collapse: false
            });
            console.log('[ExtBuilder] Workspace injected. Initial block count:', workspace.getAllBlocks(false).length);

            // Force scale to match original TurboWarp (BLOCKS_DEFAULT_SCALE = 0.55)
            // This ensures blocks are the same size as turbowarp.org/editor
            // even if startScale option was ignored by scratch-blocks.
            try {
                if (workspace.setScale) workspace.setScale(0.55);
            } catch(e) {}

            // Hide inline input fields when a reporter block is plugged into the
            // same socket. Blockly's input_value renderer doesn't know that
            // we appended a field, so we toggle the field's SVG group
            // (g.blocklyEditableText / blocklyFieldTextGroup) visibility
            // directly on every change.
            // (no runtime helper needed — placeholder fields are declared in args0.)
            // (placeholder fields are declared directly in BLOCK_DEFINITIONS
            // args0; Blockly handles placeholder visibility automatically when
            // a target block is plugged in — no runtime sync needed.)

            // CRITICAL: scratch-blocks queries container size on inject and caches it.
            // After CSS layout completes, the host div may have grown from 0 → N px.
            // We must call resizeSvg on next animation frame so the SVG fills the host.
            const forceResize = () => {
                try {
                    if (typeof Blockly.svgResize === 'function') {
                        Blockly.svgResize(workspace);
                    } else if (typeof workspace.resizeSvg === 'function') {
                        workspace.resizeSvg();
                    } else if (typeof Blockly.resizeSvg === 'function') {
                        Blockly.resizeSvg();
                    }
                    if (typeof Blockly.fireUiEvent === 'function') {
                        Blockly.fireUiEvent(workspace, 'resize');
                    } else if (typeof workspace.fireUiEvent === 'function') {
                        workspace.fireUiEvent('resize');
                    }
                } catch (e) {
                    console.warn('[ExtBuilder] resizeSvg failed:', e);
                }
                console.log('[ExtBuilder] Workspace resized. SVG size:', workspace.getMetrics ? (() => {
                    const m = workspace.getMetrics();
                    return m ? `${Math.round(m.viewWidth)}x${Math.round(m.viewHeight)}` : 'no metrics';
                })() : 'no metrics method');
            };

            // Resize on next animation frame (DOM has been laid out by then)
            requestAnimationFrame(() => {
                requestAnimationFrame(forceResize);
                // Re-apply scale after resize (resizeSvg may reset it)
                try { if (workspace.setScale) workspace.setScale(0.55); } catch(e) {}

                // ─── flyout 几何对齐（CSS 改不动的部分在这里改）───
                // scratch-blocks 的布局坐标是两处写死的常量算出来的：
                //   flyout.left = Toolbox.width(310) - Flyout.DEFAULT_WIDTH(250) = 60
                // CSS 里 .blocklyFlyout{width:280px} 只改视觉盒子，Blockly 的
                // 布局坐标不认 —— 结果 flyout 视觉 280 宽、坐标仍按 250 定位，
                // 多出的 30px 直接叠在工作区上；工具箱分类栏也一样，改窄后
                // flyout 不会跟着左移。所以必须在实例上同步改这两个常量：
                const TOOLBOX_W = 45;   // 与 CSS 的 .blocklyToolboxDiv{width:45px} 一致
                const FLYOUT_W = 280;   // 与 CSS 的 .blocklyFlyout{width:280px} 一致
                try {
                    if (workspace.toolbox_) workspace.toolbox_.width = TOOLBOX_W + FLYOUT_W;
                    const flyoutApi = workspace.getFlyout ? workspace.getFlyout() : null;
                    if (flyoutApi) flyoutApi.DEFAULT_WIDTH = FLYOUT_W;
                } catch (e) { /* 旧版无 toolbox_ 字段时忽略 */ }

                // 修复 flyout 积木左侧被裁切：
                // Blockly 默认 translateX=0 导致积木左边缘紧贴 flyout 左边界，
                // 帽子形状弧形和文字开头被截断。
                //
                // 为什么做成幂等函数 + MutationObserver 而不是老的一次性 +15px：
                // flyout 的积木画布 transform 会被 Blockly 在**每次**分类切换 /
                // flyout 滚动 / 窗口 resize 时重新计算并写回 translateX=0，
                // 一次性补丁在下一次重排后就丢了 —— 用户看到的正是
                // 「刚打开是好的，切了个分类积木又被挡住」。这里改为：
                // 给 flyout 留出固定左边距（MATARGIN_X=15），并观察 transform
                // 属性变化，一旦被 Blockly 重置就立即补回。
                const FLYOUT_MARGIN_X = 15;
                const patchFlyoutOffset = () => {
                    try {
                        const flyout = document.querySelector('.blocklyFlyout');
                        if (!flyout) return;

                        // 让 Blockly 按新的常量重新定位 flyout（等价于分类切换时
                        // 的重排），常量已在上方改过：left = toolbox.width - 280
                        const flyoutApi = workspace.getFlyout ? workspace.getFlyout() : null;
                        if (flyoutApi && typeof flyoutApi.position === 'function') {
                            flyoutApi.position();
                        }

                        // 同步 clip-path 到 flyout 实际尺寸：Blockly 默认的
                        // clipPath rect 比 flyout 小几像素，边缘积木会被多裁一条。
                        const clipRect = document.getElementById('blocklyBlockMenuClipRect');
                        if (clipRect) {
                            const fr = flyout.getBoundingClientRect();
                            clipRect.setAttribute('width', Math.max(1, Math.round(fr.width)));
                            clipRect.setAttribute('height', Math.max(1, Math.round(fr.height)));
                        }

                        const canvas = flyout.querySelector('.blocklyBlockCanvas');
                        if (!canvas) return;
                        const t = canvas.getAttribute('transform') || '';
                        const m = t.match(/translate\(([^,]+),\s*([^)]+)\)/);
                        if (!m) return;
                        const curX = parseFloat(m[1]);
                        if (Math.abs(curX - FLYOUT_MARGIN_X) < 0.5) return; // 已是目标值
                        canvas.setAttribute('transform',
                            'translate(' + FLYOUT_MARGIN_X + ',' + m[2] + ') scale(0.55)');
                    } catch (e) { /* flyout 未渲染完，等下一轮 */ }
                };

                // 初始补一次（rAF 后 flyout 已渲染）
                patchFlyoutOffset();

                // 持续盯住：transform 被 Blockly 重写 → 立即补回。
                // 只看 transform 属性变化，开销可忽略。
                //
                // 为什么挂在 document.body 而不是 .blockly-host：
                // 这个 rAF 闭包只在组件挂载后跑一次，而 devServer 热更新 /
                // 组件重挂载会替换掉 .blockly-host 节点 —— 挂在旧节点上的
                // observer 随旧节点一起失效，但 `__flyoutOffsetObserver`
                // 标记查不到时注册代码也不会再跑（闭包已结束），observer
                // 就这样静默丢失。挂在 body 上不受子树重建影响，单例标记
                // 也只属于 body 一个节点，生命周期与页面相同。
                try {
                    if (!document.body.__flyoutOffsetObserver) {
                        const obs = new MutationObserver(patchFlyoutOffset);
                        obs.observe(document.body, {
                            subtree: true,
                            attributes: true,
                            attributeFilter: ['transform']
                        });
                        document.body.__flyoutOffsetObserver = obs;
                    }
                } catch (e) { /* 观察 API 不可用时退化为初始补丁 */ }
            });
            // Also resize on a delayed schedule as a safety net
            const resizeTimer = setTimeout(() => {
                forceResize();
                try { if (workspace.setScale) workspace.setScale(0.55); } catch(e) {}
                // 延迟修复：flyout 可能在 250ms 后才完全渲染，再补一次偏移
                // （patchFlyoutOffset 定义在上方 rAF 闭包里，这里直接查 DOM 重做）
                try {
                    const flyout2 = document.querySelector('.blocklyFlyout');
                    const canvas2 = flyout2 ? flyout2.querySelector('.blocklyBlockCanvas') : null;
                    if (canvas2) {
                        const t2 = canvas2.getAttribute('transform') || '';
                        const m2 = t2.match(/translate\(([^,]+),\s*([^)]+)\)/);
                        if (m2 && Math.abs(parseFloat(m2[1]) - 15) >= 0.5) {
                            canvas2.setAttribute('transform',
                                'translate(15,' + m2[2] + ') scale(0.55)');
                        }
                    }
                } catch(e2) {}
            }, 250);

            // Translate default Scratch toolbox categories from English to Chinese.
            // scratch-blocks injects its own category menu (scratchCategoryMenu)
            // with English names like "Motion". We rewrite them in the DOM on the
            // next frame after the menu has been rendered.
            const enToZh = {
                Motion: '运动', Looks: '外观', Sound: '声音',
                Events: '事件', Control: '控制', Sensing: '侦测',
                Operators: '运算', Data: '数据', DataLists: '数据列表',
                More: '更多', Extensions: '扩展',
                Variables: '变量', 'My Blocks': '自制积木'
            };
            const translateToolbox = () => {
                const labels = document.querySelectorAll('.scratchCategoryMenuItemLabel');
                let translated = 0;
                labels.forEach(el => {
                    const raw = el.textContent.trim();
                    if (enToZh[raw] && el.textContent !== enToZh[raw]) {
                        el.textContent = enToZh[raw];
                        translated++;
                    }
                });
                // Also try aria-label / title on the menu item itself
                const items = document.querySelectorAll('.scratchCategoryMenuItem');
                items.forEach(el => {
                    const match = el.className.match(/scratchCategoryId-(\w+)/);
                    if (!match) return;
                    const eng = match[1].charAt(0).toUpperCase() + match[1].slice(1);
                    if (enToZh[eng]) {
                        // Update aria-label or any visible attribute
                        const label = el.querySelector('.scratchCategoryMenuItemLabel');
                        if (!label) {
                            // Fallback: create label if missing
                            const span = document.createElement('span');
                            span.className = 'scratchCategoryMenuItemLabel';
                            span.textContent = enToZh[eng];
                            el.appendChild(span);
                            translated++;
                        }
                    }
                });

                // Translate the small "Extension" header text that scratch-blocks
                // renders at the top of every extension_xxx block in the flyout.
                // The text is rendered as an SVG <text> by the FlyoutExtensionCategoryHeader
                // or by the block itself. Match on text content == "Extension" only.
                const extLabels = document.querySelectorAll('text.blocklyText');
                extLabels.forEach(el => {
                    const txt = (el.textContent || '').trim();
                    if (txt === 'Extension') {
                        el.textContent = '扩展';
                        translated++;
                    }
                });

                // Translate the flyout section header text (e.g. "Extensions"
                // that appears below the "Make a Block" button inside the
                // 制作积木 flyout). Class is blocklyFlyoutLabelText.
                const flyoutLabels = document.querySelectorAll('.blocklyFlyoutLabelText');
                flyoutLabels.forEach(el => {
                    const txt = (el.textContent || '').trim();
                    if (enToZh[txt] && el.textContent !== enToZh[txt]) {
                        el.textContent = enToZh[txt];
                        translated++;
                    } else if (txt === 'Extensions') {
                        el.textContent = '扩展积木';
                        translated++;
                    } else if (txt === 'Extension') {
                        el.textContent = '扩展';
                        translated++;
                    }
                });

                // Category dot click navigation: let scratch-blocks handle it
                // natively. In multi-category toolbox mode, clicking a dot
                // scrolls the flyout to that category while keeping all other
                // categories' blocks visible below/above. No custom filtering
                // is needed — scratch-blocks' setSelectedItemFactory already
                // does this (toolbox.js:732).

                // Inject a 创建积木 button at the bottom of the flyout.
                // Blockly's flyout and workspace roots are <svg>, so HTML
                // children get zero size. Append to the host div (HTML) and
                // absolute-position over the bottom of the flyout.
                const flyout = document.querySelector('.blocklyFlyout');
                if (!flyout) {
                    // flyout not rendered yet, skip this cycle
                    return false;
                }

                if (translated > 0) {
                    console.log('[ExtBuilder] Translated', translated, 'toolbox category labels to Chinese');
                }
                return translated > 0;
            };
            // Retry up to 5 times (every 200ms) until toolbox DOM is ready
            const translateTimer = setInterval(() => {
                if (translateToolbox()) clearInterval(translateTimer);
            }, 200);
            setTimeout(() => {
                clearInterval(translateTimer);
                translateToolbox(); // one last attempt
            }, 1500);

            // HTML floating preview widget — shown below ANY reporter block
            // (oval or hex shape, i.e. has outputConnection) when clicked.
            const isReporter = (block) => !!block.outputConnection;
            const previewDivs = {}; // block.id -> { div, block }
            var activePreviewBlockId = null;

            const ensurePreviewDiv = (block) => {
                if (!isReporter(block)) return;
                var text = '';
                var vf = block.getField('VALUE');
                if (!vf && block.type === 'logic_boolean') vf = block.getField('BOOL');
                if (!vf && block.type === 'math_number') vf = block.getField('NUM');
                if (vf) {
                    var raw = vf.getValue();
                    if (block.type === 'logic_boolean') {
                        // Show true/false in the white box, not 真/假
                        text = raw === 'TRUE' ? 'true' : 'false';
                    } else {
                        text = raw || '';
                    }
                }
                // For blocks whose VALUE field is empty (return blocks with
                // nothing plugged in), fall through to the code generator
                // to show the actual computed value.
                if (!text) {
                    try {
                        var fn = CODE_GENERATORS[block.type];
                        if (typeof fn === 'function') {
                            var code = fn(block);
                            if (Array.isArray(code)) code = code[0];
                            code = String(code || '');

                            // Build a sandbox with a stub runtime so blocks
                            // like mouseX / timer can produce real-looking values.
                            var sandbox = {
                                Math: Math,
                                String: String,
                                Number: Number,
                                Array: Array,
                                // Common scratch runtime objects referenced by code
                                runtime: {
                                    ioDevices: {
                                        mouse: {
                                            getScratchX: function () { return window.mouseX || 0; },
                                            getScratchY: function () { return window.mouseY || 0; },
                                            getIsDown: function () { return false; }
                                        },
                                        keyboard: {
                                            getKeyIsDown: function () { return false; }
                                        }
                                    },
                                    currentMSecs: 0,
                                    frameRate: 30,
                                    start: function () {},
                                    stop: function () {},
                                    createClone: function () {},
                                    deleteThisClone: function () {},
                                    broadcast: function () {}
                                },
                                // Stub scratch list/variable references (commonly
                                // appear in list_contains, var_get, etc.)
                                myList: [],
                                list: [],
                                arr: [],
                                __var: 0,
                                __str: '',
                                __bool: false,
                                __arr: []
                            };
                            var keys = Object.keys(sandbox);
                            var vals = keys.map(function (k) { return sandbox[k]; });
                            var fnBody = 'return (' + code + ')';
                            try {
                                var result = (new Function(...keys, fnBody))(...vals);
                                window.__extEvalDebug = {code: code, fnBody: fnBody, result: result};
                            } catch (e2) {
                                // ReferenceError (e.g. undefined variable name from
                                // user's list/var) → boolean blocks fall back to
                                // false, value blocks show the code expression
                                // itself (never a misleading 'false').
                                var blockDef = BLOCK_DEFINITIONS[block.type];
                                var isHex = blockDef && blockDef.output === 'Boolean';
                                if (e2 instanceof ReferenceError ||
                                    /is not defined/.test(e2.message)) {
                                    result = isHex ? false : code;
                                    window.__extEvalErr = e2.message;
                                } else {
                                    result = code; // unknown error → show code
                                    window.__extEvalErr = e2.message;
                                }
                            }
                            // Format the value — booleans always become 'true'/'false'
                            if (typeof result === 'boolean') {
                                text = 'true' === String(result) ? 'true' :
                                       'false' === String(result) ? 'false' : String(result);
                            } else if (typeof result === 'number') {
                                text = Number.isInteger(result) ? String(result) :
                                    code.indexOf('Math.PI') >= 0 ? result.toFixed(6) :
                                    String(Math.round(result * 1000) / 1000);
                            } else if (typeof result === 'string') {
                                text = result;
                            } else if (result === undefined || result === null) {
                                // Undefined result (e.g. list index out of
                                // range) → show the code expression, never
                                // the literal string 'undefined'
                                text = code;
                            } else if (code === 'true' || code === 'false') {
                                text = code;
                            } else {
                                text = String(result);
                            }
                        } else { text = '...'; }
                    } catch (e) { text = '...'; }
                }
                var entry = previewDivs[block.id];
                if (!entry) {
                    var wrap = document.createElement('div');
                    wrap.className = 'ext-value-preview';
                    wrap.style.cssText = [
                        'position:absolute','z-index:999',
                        'background:#ffffff','border:1px solid #cccccc',
                        'border-radius:8px',
                        'box-shadow:0 1px 2px rgba(0,0,0,0.15),0 3px 12px rgba(0,0,0,0.2),0 6px 24px rgba(0,0,0,0.1)',
                        'padding:4px 6px',
                        'font-family:Helvetica,Arial,sans-serif','font-size:13px','font-weight:500',
                        'color:#222222',
                        'white-space:nowrap','text-align:center',
                        'display:inline-flex','align-items:center','gap:6px',
                        'display:none','transition:opacity 0.15s ease','opacity:0',
                        'pointer-events:auto'
                    ].join(';');

                    var span = document.createElement('span');
                    span.className = 'ext-value-text';
                    span.style.cssText = 'min-width:18px; user-select:text;';

                    var btn = document.createElement('button');
                    btn.className = 'ext-value-copy';
                    btn.textContent = '\uD83D\uDCCB';
                    btn.title = '\u590D\u5236\u8FD4\u56DE\u503C';
                    btn.style.cssText = [
                        'background:none','border:none','cursor:pointer',
                        'font-size:12px','padding:1px 3px','margin:0',
                        'line-height:1','opacity:0.5',
                        'border-radius:4px'
                    ].join(';');
                    btn.onmouseenter = function () { this.style.opacity = '1'; };
                    btn.onmouseleave = function () { this.style.opacity = '0.5'; };
                    btn.onclick = function (e) {
                        e.stopPropagation();
                        var txt = span.textContent || '';
                        if (navigator.clipboard) {
                            navigator.clipboard.writeText(txt).then(function () {
                                btn.textContent = '\u2714\uFE0F';
                                setTimeout(function () { btn.textContent = '\uD83D\uDCCB'; }, 1200);
                            });
                        }
                    };

                    wrap.appendChild(span);
                    wrap.appendChild(btn);
                    document.body.appendChild(wrap);
                    entry = { div: wrap, span: span };
                    previewDivs[block.id] = entry;
                }
                entry.block = block;
                // Hex blocks (output: 'Boolean') MUST show only true / false
                var def = BLOCK_DEFINITIONS[block.type];
                var isHexBlock = def && def.output === 'Boolean';
                if (isHexBlock) {
                    if (text !== 'true' && text !== 'false') {
                        text = (!text || text === '...' || text === '0') ? 'false' : 'true';
                    }
                }
                entry.span.textContent = text || '...';
            };

            const showPreview = (block) => {
                var entry = previewDivs[block.id];
                if (!entry) return;
                var svgRoot = block.getSvgRoot();
                if (!svgRoot) return;
                var rect = svgRoot.getBoundingClientRect();
                var div = entry.div;
                // Cancel any pending fade-out timer
                if (div._fadeTimer) { clearTimeout(div._fadeTimer); div._fadeTimer = null; }
                div.style.display = 'inline-flex';
                div.style.left = (rect.left + rect.width / 2) + 'px';
                div.style.top = (rect.bottom + 4) + 'px';
                div.style.opacity = '1';
                activePreviewBlockId = block.id;
            };

            const hideAllPreviews = () => {
                activePreviewBlockId = null;
                var ids = Object.keys(previewDivs);
                for (var i = 0; i < ids.length; i++) {
                    var div = previewDivs[ids[i]].div;
                    div.style.opacity = '0';
                    // Hide after fade completes — store handle to cancel on re-show
                    div._fadeTimer = setTimeout(function (d) {
                        d.style.display = 'none';
                    }.bind(null, div), 120);
                }
            };

            const repositionActive = () => {
                if (!activePreviewBlockId) return;
                var entry = previewDivs[activePreviewBlockId];
                if (!entry) return;
                var block = entry.block;
                if (!block || !block.workspace) {
                    // Block was deleted — faded hide
                    if (entry.div) { entry.div.style.opacity = '0'; }
                    activePreviewBlockId = null;
                    return;
                }
                var svgRoot = block.getSvgRoot();
                if (!svgRoot) return;
                var rect = svgRoot.getBoundingClientRect();
                entry.div.style.left = (rect.left + rect.width / 2) + 'px';
                entry.div.style.top = (rect.bottom + 4) + 'px';
                entry.div.style.opacity = '1';
            };

            const removePreviewDiv = (block) => {
                var entry = previewDivs[block.id];
                if (entry) {
                    if (entry.div && entry.div.parentNode) {
                        entry.div.parentNode.removeChild(entry.div);
                    }
                    delete previewDivs[block.id];
                }
                if (activePreviewBlockId === block.id) activePreviewBlockId = null;
            };

            // Ensure every reporter block has its hidden div created
            const refreshValueBoxes = () => {
                workspace.getAllBlocks(false).forEach(function (b) {
                    if (!isReporter(b)) { removePreviewDiv(b); return; }
                    ensurePreviewDiv(b);
                });
            };

            // Single capture-phase handler: intercept ALL mousedowns before
            // any Blockly handler. Decision matrix:
            //  - dropdown text → pass through (Blockly opens dropdown)
            //  - preview block body → stop + show white box
            //  - outside → hide white box
            document.addEventListener('mousedown', function (e) {
                var el = e.target;
                while (el) {
                    if (el.classList && el.classList.contains('ext-value-preview')) return;
                    el = el.parentNode;
                }
                // Walk up to find what was clicked
                var clickedBlockId = null;
                var onDropdownText = false;
                var inDropDown = false;
                el = e.target;
                while (el) {
                    // Skip if clicking inside Blockly's dropdown menu
                    if (el.classList && (
                        el.classList.contains('blocklyDropDownDiv') ||
                        el.classList.contains('blocklyWidgetDiv'))) {
                        inDropDown = true;
                    }
                    if (el.classList && el.classList.contains('blocklyDropdownText')) {
                        onDropdownText = true;
                    }
                    if (el.classList && el.classList.contains('blocklyDraggable')) {
                        clickedBlockId = el.getAttribute('data-id');
                        break;
                    }
                    el = el.parentElement;
                }
                // Dropdown area → let Blockly handle everything, keep preview
                if (onDropdownText || inDropDown) {
                    window.__extDropClick = (window.__extDropClick||0)+1;
                    return;
                }
                // Preview block body → show white box
                if (clickedBlockId && previewDivs[clickedBlockId]) {
                    var blk = workspace.getBlockById(clickedBlockId);
                    if (blk && isReporter(blk)) {
                        // Boolean block: stop event so Blockly doesn't open dropdown
                        if (blk.type === 'logic_boolean') {
                            e.stopImmediatePropagation();
                        }
                        showPreview(blk);
                        return;
                    }
                }
                // Outside → hide white box, let event continue to Blockly
                hideAllPreviews();
            }, true); // capture phase

            // MutationObserver on workspace SVG — refresh divs and
            // reposition active preview when DOM changes
            try {
                var svgCanvas = workspace.getCanvas();
                if (svgCanvas && window.MutationObserver) {
                    var valueBoxObserver = new MutationObserver(function () {
                        refreshValueBoxes();
                        repositionActive();
                    });
                    valueBoxObserver.observe(svgCanvas, {
                        childList: true, subtree: true,
                        attributes: false, characterData: true
                    });
                }
            } catch (e) {
                console.warn('Could not set up value box observer:', e);
            }

            // Hat-block visual fix: the top curve is drawn at negative-y
            // coordinates and gets clipped, so shift every hat block's
            // group down by 18px to bring the curve into view.
            try {
                const hatFix = () => {
                    if (!svgCanvas) return;
                    svgCanvas.querySelectorAll('.blocklyDraggable[data-shapes~="hat"]').forEach(function (g) {
                        if (g.getAttribute('data-hat-fixed') === '1') return;
                        g.setAttribute('data-hat-fixed', '1');
                        const cur = g.getAttribute('transform') || '';
                        const m = cur.match(/translate\(([^)]+)\)/);
                        const baseX = m ? Number(m[1].split(',')[0]) || 0 : 0;
                        const baseY = m ? Number(m[1].split(',')[1]) || 0 : 0;
                        g.setAttribute('transform', 'translate(' + baseX + ',' + (baseY + 18) + ')');
                    });
                };
                hatFix();
                if (window.MutationObserver) {
                    new MutationObserver(hatFix).observe(svgCanvas, {childList: true, subtree: true});
                }
            } catch (e) { /* cosmetic — never crash */ }

            // Reposition on drag/zoom/move via Blockly events
            if (typeof workspace.addChangeListener === 'function') {
                workspace.addChangeListener(function (e) {
                    if (e.type === Blockly.Events.UI ||
                        e.type === Blockly.Events.MOVE ||
                        e.type === Blockly.Events.DRAG) {
                        repositionActive();
                    }
                    refreshValueBoxes();
                });
            }
            window.addEventListener('resize', repositionActive);
            if (blocklyDivRef.current) {
                blocklyDivRef.current.addEventListener('scroll', repositionActive);
            }
            // Track mousemove to keep the white box following the block
            // during drags (Blockly uses a drag surface that doesn't
            // trigger DOM events while moving).
            document.addEventListener('mousemove', function (e) {
                if (e.buttons && activePreviewBlockId) {
                    repositionActive();
                }
            });

            // Auto-generate JS code + auto-save workspace XML on every change.
            // Debounced so dragging blocks doesn't re-render the whole UI
            // (including the floating builder window) on every mouse move.
            let wsSaveTimer = null;
            workspace.addChangeListener((event) => {
                try {
                    if (event.type !== Blockly.Events.UI) {
                        if (wsSaveTimer) clearTimeout(wsSaveTimer);
                        wsSaveTimer = setTimeout(() => {
                            try {
                                const code = javascriptGenerator.workspaceToCode(workspace);
                                setGeneratedCode(code);
                                setStatsTick(t => t + 1); // 触发 projectStats 重算
                            } catch (genErr) { /* silent */ }
                            try {
                                const B = window._extBuilderBlockly || window.Blockly;
                                if (B && B.Xml) {
                                    // Save XML to a ref (not React state) so drags
                                    // don't re-render the builder window.
                                    customBlockXmlRef.current.set(currentBlockRef.current,
                                        B.Xml.domToText(B.Xml.workspaceToDom(workspace)));
                                }
                            } catch (saveErr) { /* silent */ }
                        }, 400);
                    }
                    // Keep the value preview label below return
                    // blocks in sync with the actual value.
                    if (event.type === Blockly.Events.BLOCK_CHANGE && event.blockId) {
                        const changed = workspace.getBlockById(event.blockId);
                        if (!changed) return;
                        if (changed.type === 'control_return' ||
                            changed.type === 'control_inlineReturn' ||
                            changed.type === 'func_return') {
                            const label = changed.getField('VALUE');
                            if (label) {
                                const v = javascriptGenerator.valueToCode(changed, 'VALUE', 0) || '';
                                label.setValue(v);
                            }
                        }
                    }
                    // Remove preview divs for deleted blocks
                    if (event.type === Blockly.Events.DELETE && event.oldBlockIds) {
                        for (var i = 0; i < event.oldBlockIds.length; i++) {
                            var did = event.oldBlockIds[i];
                            if (previewDivs[did] && previewDivs[did].parentNode) {
                                previewDivs[did].parentNode.removeChild(previewDivs[did]);
                            }
                            delete previewDivs[did];
                        }
                    }
                    refreshValueBoxes();
                } catch (e) {
                    console.error('Code generation error:', e);
                }
            });


            // Attach to window for debugging
            window._extBuilderWorkspace = workspace;
            window._extBuilderBlockly = Blockly;
            window._extBuilderGenerator = javascriptGenerator;
            window._extBuilderCustomBlocks = customBlocks;

            // Seed the workspace with starter blocks for every existing
            // customBlock so the canvas is populated immediately. Subsequent
            // starter blocks are added by handleCreateBlock.
            customBlocks.forEach((b) => {
                addStarterBlocks(workspace, Blockly, b.name, b.id, b.blockType, b.colour);
            });
            if (customBlocks.length) {
                const first = findBlockByCustomId(workspace, customBlocks[0].id);
                if (first && workspace.select) {
                    workspace.select(first);
                }
            }

            workspaceRef.current = workspace;
            setWorkspaceLoaded(true);
            // 清理主工作区重复块（防御注入瞬间出现的副本，如 target_clone
            // 有时会被复制成 2 个，残留一个孤立椭圆显示在屏幕左上角）
            try {
                const seen = new Set();
                workspace.getTopBlocks(true).forEach(b => {
                    const key = (b.type || '?') + ':' + (b.getFieldValue && (b.getFieldValue('NAME') || b.getFieldValue('TYPE') || ''));
                    if (seen.has(key)) b.dispose(false);
                    else seen.add(key);
                });
            } catch (e) { /* 清理失败无关紧要 */ }
            // 拖动结束 + 工具箱 flyout 拖动时：清理任何独立显示的 ghost 元素
            // （scratch-blocks 拖动带 input_value 字段的块时，字段会作为 ghost
            // 在屏幕外独立显示——比如截图1里左上角孤立显示"克隆体"的椭圆）
            try {
                const INPUT_VALUE = (Blockly.inputsValue || Blockly.INPUT_VALUE || 1);
                const hideInputGhosts = () => {
                    // 1) 隐藏所有 .blocklyInputRow 元素（input_value 字段 SVG 容器）
                    //    如果它们不在任何 block 主体内（孤立显示）
                    //    同时清理 main workspace 和 dragSurface 内部
                    ['.blocklyMainWorkspace', '.blocklyBlockDragSurface'].forEach(function(sel) {
                        const svg = document.querySelector(sel);
                        if (!svg) return;
                        svg.querySelectorAll('.blocklyInputRow').forEach(row => {
                            if (!row.closest('.blocklyDraggable')) {
                                row.style.display = 'none';
                            }
                        });
                    });
                    // 2) 拖动结束后强制隐藏 blocklyBlockDragSurface
                    const ds = document.querySelector('.blocklyBlockDragSurface');
                    if (ds && !(workspace.isDragging && workspace.isDragging())) {
                        ds.style.display = 'none';
                    }
                };
                workspace.addChangeListener((event) => {
                    if (event && event.type === Blockly.Events.BLOCK_CREATE) {
                        // 延后一毫秒再隐藏（等块内的脱联 input_value 字段创建出来）
                        setTimeout(hideInputGhosts, 0);
                    }
                });
                // 兜底：每次 mouseup 后再清理一次（拖动结束时也可能有 ghost 残留）
                const injectionDiv = workspace.getInjectionDiv();
                if (injectionDiv) {
                    injectionDiv.addEventListener('pointerup', () => {
                        setTimeout(hideInputGhosts, 50);
                    });
                }
                // 终极兜底：每 200ms 检查 blocklyBlockDragSurface，非拖动时强制 hide
                // （scratch-blocks 拖动时 set display:block，mouseup 后偶尔不重置）
                const dragSurfaceWatcher = setInterval(() => {
                    const ds = document.querySelector('.blocklyBlockDragSurface');
                    if (!ds) return;
                    const isDragging = !!(workspace.isDragging && workspace.isDragging());
                    const dsHasContent = (ds.children[0] && ds.children[0].childNodes.length > 0);
                    if (!isDragging && dsHasContent) {
                        ds.style.display = 'none';
                    } else if (!isDragging && ds.style.display !== 'none') {
                        ds.style.display = 'none';
                    }
                }, 200);
                // 终极 v6：覆写 BlockDragSurfaceSvg.setBlocksAndShow——
                // 拖动开始时立即隐藏拖动副本里的 input 字段（不依赖 CSS 选择器）
                try {
                    const BlockDragSurfaceSvg = Blockly.BlockDragSurfaceSvg;
                    if (BlockDragSurfaceSvg && BlockDragSurfaceSvg.prototype) {
                        const origSetBlocks = BlockDragSurfaceSvg.prototype.setBlocksAndShow;
                        BlockDragSurfaceSvg.prototype.setBlocksAndShow = function(blocks) {
                            const result = origSetBlocks.call(this, blocks);
                            // 立即隐藏拖动副本中所有 input 字段
                            if (this.dragGroup_) {
                                this.dragGroup_.querySelectorAll(
                                    'g.blocklyInputRow, path:not(.blocklyBlockBackground), ' +
                                    'path[data-argument-type], ellipse, rect.blocklyInputRow, .blocklyShape'
                                ).forEach(el => {
                                    el.style.display = 'none';
                                });
                            }
                            return result;
                        };
                    }
                } catch (e) { /* 覆写失败无关紧要 */ }
                // 终极 v7：监听主工作区 blocklyBlockCanvas 上的元素新增
                // 任何不在 blocklyDraggable 内的 input socket 立即隐藏
                // （用户拖动时主工作区会出现跟随鼠标的孤立 input ghost）
                try {
                    const mainCanvas = document.querySelector('.blocklyBlockCanvas');
                    if (mainCanvas && window.MutationObserver) {
                        const mainOrphanObserver = new MutationObserver((mutations) => {
                            mutations.forEach(m => {
                                m.addedNodes.forEach(node => {
                                    if (node && node.querySelectorAll) {
                                        node.querySelectorAll(
                                            'g.blocklyInputRow, ' +
                                            'path:not(.blocklyBlockBackground), ' +
                                            'path[data-argument-type], ' +
                                            'ellipse, rect.blocklyInputRow, .blocklyShape'
                                        ).forEach(el => {
                                            if (!el.closest('.blocklyDraggable')) {
                                                el.style.display = 'none';
                                            }
                                        });
                                    }
                                });
                            });
                        });
                        mainOrphanObserver.observe(mainCanvas, {childList: true, subtree: true});
                    }
                } catch (e) { /* observer 失败无关紧要 */ }
                // 终极 v8：监听 scratch-blocks 拖动表面（避免 document.body 监听导致 reflow 警告）
                try {
                    if (window.MutationObserver) {
                        const dragSurf = document.querySelector('.blocklyBlockDragSurface');
                        const mainCanvas = document.querySelector('.blocklyBlockCanvas');
                        const bubbleCanvas = document.querySelector('.blocklyBubbleCanvas');
                        const targets = [dragSurf, mainCanvas, bubbleCanvas].filter(Boolean);
                        targets.forEach(function(target) {
                            try {
                                const obs = new MutationObserver(function(mutations) {
                                    mutations.forEach(m => {
                                        m.addedNodes.forEach(node => {
                                            if (node && node.querySelectorAll) {
                                                node.querySelectorAll(
                                                    'g.blocklyInputRow, ' +
                                                    'path:not(.blocklyBlockBackground), ' +
                                                    'path[data-argument-type], ' +
                                                    'ellipse, rect.blocklyInputRow, .blocklyShape, ' +
                                                    'g.blocklyInsertionMarker, .blocklyInsertionMarker'
                                                ).forEach(el => {
                                                    if (!el.closest('.blocklyDraggable')) {
                                                        el.style.display = 'none';
                                                    }
                                                });
                                            }
                                        });
                                    });
                                });
                                obs.observe(target, {childList: true, subtree: true});
                            } catch (e) { /* 单个 observer 失败无关紧要 */ }
                        });
                    }
                } catch (e) { /* observer 失败无关紧要 */ }
                // 终极 v10：暴力兜底 —— 任何 fill="#529552" 元素不在 blocklyDraggable 内立即隐藏
                // 覆盖 v9 漏掉的所有 input socket 形状
                try {
                    if (window.MutationObserver) {
                        const v10obs = new MutationObserver(function(mutations) {
                            mutations.forEach(m => {
                                m.addedNodes.forEach(node => {
                                    if (node && node.querySelectorAll) {
                                        node.querySelectorAll('[fill="#529552"], [fill="#0FBD8C"]').forEach(el => {
                                            if (!el.closest('.blocklyDraggable')) {
                                                el.style.display = 'none';
                                            }
                                        });
                                    }
                                });
                            });
                        });
                        v10obs.observe(document.body, {childList: true, subtree: true, attributes: true});
                    }
                } catch (e) { /* v10 失败无关紧要 */ }
                // 终极兜底：MutationObserver 监听 dragSurface 内部的孤立 inputRow
                // 任何新加入的 inputRow 如果不在 .blocklyDraggable 内则立即 hide
                try {
                    const dsEl = document.querySelector('.blocklyBlockDragSurface');
                    if (dsEl && window.MutationObserver) {
                        const dsObserver = new MutationObserver((mutations) => {
                            mutations.forEach(m => {
                                m.addedNodes.forEach(node => {
                                    if (node && node.querySelectorAll) {
                                        node.querySelectorAll('.blocklyInputRow').forEach(row => {
                                            if (!row.closest('.blocklyDraggable')) {
                                                row.style.display = 'none';
                                            }
                                        });
                                    }
                                });
                            });
                        });
                        dsObserver.observe(dsEl, {childList: true, subtree: true});
                    }
                } catch (e) { /* observer 失败无关紧要 */ }
                // 页面卸载时清除定时器
                if (workspace.dispose) {
                    const origDispose = workspace.dispose.bind(workspace);
                    workspace.dispose = function() {
                        clearInterval(dragSurfaceWatcher);
                        return origDispose();
                    };
                }
            } catch (e) { /* drag 监听失败无关紧要 */ }
            return () => {
                clearTimeout(resizeTimer);
            };
        } catch (e) {
            console.error('Failed to initialize Blockly:', e);
            setLoadError('Blockly initialization failed: ' + (e.message || String(e)));
            return undefined;
        }
    }, [loaded, workspaceLoaded]);

    // 插件激活（独立 effect）：workspace 就绪后激活 ExtAddons。
    // 必须放在独立 useEffect 里——若与 workspace 初始化同 effect，
    // setWorkspaceLoaded(true) 会让 effect 重新运行并先执行 cleanup，
    // 把刚激活的插件全部卸载。
    useEffect(() => {
        if (!workspaceLoaded || !workspaceRef.current) return;
        const Blockly = window._extBuilderBlockly || window.Blockly;
        if (!Blockly) return;
        if (extAddonsCleanupRef.current) return; // 已激活
        let cancelled = false;
        // 先扫「编辑器数据文件夹」里的插件（终端安装的落点），再统一激活。
        // 浏览器读不了本地目录，所以这一步是向 Node 侧要清单；接口不存在就静默跳过。
        loadDirPlugins()
            .catch(() => [])
            .then(() => {
                // 目录插件是异步扫出来的：这一步完成后 _dirPlugins 才有内容。
                // addonList 是 useMemo，不刷新计数器它就停在挂载时的快照上，
                // 结果就是「磁盘上明明装了插件，列表里却不显示」。
                setAddonListVersion(v => v + 1);
                return applyExtAddons({
                    Blockly,
                    getWorkspace: () => workspaceRef.current
                });
            }).then(cleanup => {
            if (!cancelled) extAddonsCleanupRef.current = cleanup;
        }).catch(e => console.warn('[ExtAddons] 激活失败:', e));
        return () => {
            cancelled = true;
            if (extAddonsCleanupRef.current) {
                try { extAddonsCleanupRef.current(); } catch (e) { /* silent */ }
                extAddonsCleanupRef.current = null;
            }
        };
    }, [workspaceLoaded]);

    const addStarterBlocks = (workspace, Blockly, blockName, blockId, blockType, colour) => {
        try {
            // Place a block_define starter for this custom block in workspace.
            // Each starter carries a `data-block-id` attribute so we can map
            // it back to the React customBlocks[] entry.
            const metrics = workspace.getMetrics ? workspace.getMetrics() : null;
            const viewW = (metrics && metrics.viewWidth) || 800;
            const viewH = (metrics && metrics.viewHeight) || 400;

            // Stack new starters below any existing top-level blocks
            const top = workspace.getTopBlocks ? workspace.getTopBlocks(true) : [];
            let bottomY = 60;
            top.forEach(b => {
                const y = (b.getRelativeToSurfaceXY && b.getRelativeToSurfaceXY().y) || 0;
                const h = b.height || 40;
                bottomY = Math.max(bottomY, y + h + 20);
            });
            const startX = Math.max(40, viewW / 2 - 60);
            const startY = bottomY;

            const def = workspace.newBlock('block_define');
            if (def) {
                // Tag with data-block-id so we can locate the block later
                const svgRoot = def.getSvgRoot && def.getSvgRoot();
                if (svgRoot && blockId) {
                    svgRoot.setAttribute('data-block-id', blockId);
                }
                const nameField = def.getField('NAME');
                if (nameField) {
                    nameField.setValue(blockName || '我的积木');
                }
                // Store non-rendered metadata used by the code generator
                // (opcode / type / display text) directly on the Blockly block.
                def._opcode = (blockId || 'block').replace(/[^a-zA-Z0-9]/g, '_');
                def._type = (blockType || 'command').toUpperCase() === 'BOOLEAN' ? 'BOOLEAN'
                    : (blockType || 'command').toUpperCase() === 'REPORTER' ? 'REPORTER'
                        : (blockType || 'command').toUpperCase() === 'HAT' ? 'HAT'
                            : (blockType || 'command').toUpperCase() === 'CONDITIONAL' ? 'CONDITIONAL'
                                : 'COMMAND';
                def._text = '[' + (blockName || 'block') + ']';
                // 颜色唯一真源：自定义色 > 扩展主题色（getInfo().color1）。
                // 与预览 SVG、导出代码共用 resolveBlockColour，保证
                // 工作区 / 预览 / 导出后 TurboWarp 三处颜色一致。
                const resolvedColour = resolveBlockColour({colour: colour || ''}, extColor1Ref.current);
                try { def.setColour(resolvedColour); } catch (e) { /* 忽略非法色 */ }
                // 定义扩展的积木块禁止一切删除（拖动/右键/Delete 键），
                // 防止用户误删导致工作区与代码面板失去对应关系。
                def.setDeletable(false);
                def.initSvg();
                def.moveBy(startX, startY);
                def.render();
            }
            console.log('[ExtBuilder] Starter block added for "' + blockName + '" (id=' + blockId + '). Block count:', workspace.getAllBlocks(false).length);
        } catch (e) {
            console.warn('Failed to add starter block:', e);
        }
    };

    // Find a top-level block_define carrying a given customBlock id
    const findBlockByCustomId = (workspace, blockId) => {
        if (!workspace || !blockId) return null;
        const tops = workspace.getTopBlocks(true);
        for (let i = 0; i < tops.length; i++) {
            const t = tops[i];
            if (t.type !== 'block_define') continue;
            const svg = t.getSvgRoot && t.getSvgRoot();
            if (svg && svg.getAttribute('data-block-id') === blockId) return t;
        }
        return null;
    };

    // Save current workspace to the active block's xml ref
    const saveCurrentWorkspace = useCallback(() => {
        if (!workspaceRef.current) return;
        try {
            const B = window._extBuilderBlockly || window.Blockly;
            const xml = B.Xml.domToText(B.Xml.workspaceToDom(workspaceRef.current));
            customBlockXmlRef.current.set(currentBlockRef.current, xml);
        } catch (e) {
            console.warn('Failed to save workspace:', e);
        }
    }, []);

    // Load a block's workspace into the current workspace
    const loadBlockWorkspace = useCallback((blockId, blockName) => {
        if (!workspaceRef.current) return;
        try {
            const ws = workspaceRef.current;
            ws.clear();
            const block = customBlocks.find(b => b.id === blockId);
            const B = window._extBuilderBlockly || window.Blockly;
            // Prefer the latest saved XML from the ref (kept in sync with the
            // live workspace via the change listener). Fall back to the
            // initial xml field on first load.
            const savedXml = customBlockXmlRef.current.get(blockId) ||
                (block && block.xml);
            if (savedXml) {
                const dom = B.Xml.textToDom(savedXml);
                B.Xml.domToWorkspace(dom, ws);
            } else {
                addStarterBlocks(ws, B, block?.name || blockName, block?.id, block?.blockType, block?.colour);
            }
            console.log('[ExtBuilder] Loaded workspace for block:', blockName);
        } catch (e) {
            console.warn('Failed to load workspace:', e);
            // Fallback: just add starter
            const ws = workspaceRef.current;
            const B = window._extBuilderBlockly || window.Blockly || {};
            addStarterBlocks(ws, B, blockName, block?.id, block?.blockType, block?.colour);
        }
    }, [customBlocks]);

    // Switch to a block — just highlight/focus the matching top-level
    // block_define; do NOT swap the workspace contents.
    const handleSelectBlock = useCallback((blockId) => {
        if (blockId === currentBlockRef.current) {
            // Even re-selecting the same block — focus the matching starter
            if (workspaceRef.current) {
                const target = findBlockByCustomId(workspaceRef.current, blockId);
                if (target && workspaceRef.current.select) {
                    workspaceRef.current.select(target);
                    if (workspaceRef.current.centerOnBlock) {
                        workspaceRef.current.centerOnBlock(target.id);
                    }
                }
            }
            return;
        }
        saveCurrentWorkspace();
        currentBlockRef.current = blockId;
        setCurrentBlockId(blockId);
        if (workspaceRef.current) {
            const target = findBlockByCustomId(workspaceRef.current, blockId);
            if (target && workspaceRef.current.select) {
                workspaceRef.current.select(target);
                if (workspaceRef.current.centerOnBlock) {
                    workspaceRef.current.centerOnBlock(target.id);
                }
            }
        }
    }, [saveCurrentWorkspace]);

    // Create a new block — append a block_define to the shared workspace
    // (no longer clears or swaps the workspace).
    const handleCreateBlock = useCallback(() => {
        const id = 'block_' + Date.now();
        const name = '我的积木 ' + (customBlocks.length + 1);
        setCustomBlocks(prev => [...prev, {
            id, name, xml: null,
            blockType: 'command', isTerminal: false, isAsync: false,
            attachAllThreads: false, filterSprite: true, filterStage: true, icon: '',
            colour: ''
        }]);
        currentBlockRef.current = id;
        setCurrentBlockId(id);
        if (workspaceRef.current) {
            const B = window._extBuilderBlockly || window.Blockly || {};
            addStarterBlocks(workspaceRef.current, B, name, id, 'command', '');
            // Focus the newly added block so the user sees it immediately
            const created = findBlockByCustomId(workspaceRef.current, id);
            if (created && workspaceRef.current.select) {
                workspaceRef.current.select(created);
            }
        }
    }, [customBlocks.length]);

    // Delete a block — remove from customBlocks AND from the shared workspace
    const handleDeleteBlock = useCallback((blockId) => {
        if (customBlocks.length <= 1) return; // at least one block remains
        // Remove the corresponding top-level block from the workspace
        if (workspaceRef.current) {
            const target = findBlockByCustomId(workspaceRef.current, blockId);
            if (target && target.dispose) target.dispose(false);
        }
        setCustomBlocks(prev => prev.filter(b => b.id !== blockId));
        if (blockId === currentBlockRef.current) {
            // Pick the next visible block — do NOT reload workspace
            const remaining = customBlocks.filter(b => b.id !== blockId);
            const next = remaining[remaining.length - 1];
            if (next) {
                currentBlockRef.current = next.id;
                setCurrentBlockId(next.id);
                if (workspaceRef.current) {
                    const nextBlock = findBlockByCustomId(workspaceRef.current, next.id);
                    if (nextBlock && workspaceRef.current.select) {
                        workspaceRef.current.select(nextBlock);
                    }
                }
            }
        }
    }, [customBlocks]);

    // Rename a block
    const handleRenameBlock = useCallback((blockId, newName) => {
        const trimmed = (newName || '').trim();
        if (!trimmed) return; // ignore empty names
        setCustomBlocks(prev => prev.map(b =>
            b.id === blockId ? {...b, name: trimmed} : b
        ));
        // Sync the block's NAME field on the shared workspace canvas so the
        // hat block renames immediately (CB-ExtGallary behavior).
        if (workspaceRef.current) {
            const defBlock = findBlockByCustomId(workspaceRef.current, blockId);
            if (defBlock) {
                const f = defBlock.getField('NAME');
                if (f) f.setValue(trimmed);
                if (defBlock.render) defBlock.render();
            }
        }
    }, []);

    // Begin inline rename
    const handleStartRename = useCallback((blockId, currentName) => {
        setEditingBlockId(blockId);
        setEditingName(currentName);
    }, []);

    const handleCancelRename = useCallback(() => {
        setEditingBlockId(null);
        setEditingName('');
    }, []);

    const handleCommitRename = useCallback((blockId) => {
        handleRenameBlock(blockId, editingName);
        handleCancelRename();
    }, [editingName, handleRenameBlock, handleCancelRename]);

    // Update a block's metadata (type, filters, icon, etc.) AND sync
    // the matching top-level block_define in the shared workspace.
    const handleUpdateBlock = useCallback((blockId, updates) => {
        setCustomBlocks(prev => prev.map(b =>
            b.id === blockId ? {...b, ...updates} : b
        ));
        // Sync NAME/TYPE fields to the Blockly block
        if (workspaceRef.current) {
            const defBlock = findBlockByCustomId(workspaceRef.current, blockId);
            if (defBlock) {
                if (Object.prototype.hasOwnProperty.call(updates, 'name')) {
                    const f = defBlock.getField('NAME');
                    if (f) f.setValue(updates.name);
                }
                if (Object.prototype.hasOwnProperty.call(updates, 'blockType')) {
                    const f = defBlock.getField('TYPE');
                    if (f) f.setValue(updates.blockType);
                }
                if (Object.prototype.hasOwnProperty.call(updates, 'colour')) {
                    // 清除自定义色时回退到扩展主题色（不是 290 紫），
                    // 与预览 / 导出代码保持同一规则。
                    try {
                        defBlock.setColour(resolveBlockColour(
                            {colour: updates.colour || ''},
                            extColor1Ref.current
                        ));
                    } catch (e) { /* 忽略非法色 */ }
                }
            }
        }
    }, []);

    // Upload a block icon
    const handlePickBlockIcon = useCallback((blockId) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                handleUpdateBlock(blockId, {icon: ev.target.result});
            };
            reader.readAsDataURL(file);
        };
        input.click();
    }, [handleUpdateBlock]);

    const handleClearBlockIcon = useCallback((blockId) => {
        handleUpdateBlock(blockId, {icon: ''});
    }, [handleUpdateBlock]);

    // Add a text segment to current block's template
    const handleAddText = useCallback((blockId) => {
        const value = (window.prompt('输入文本片段:') || '').trim();
        if (!value) return;
        setCustomBlocks(prev => prev.map(b => {
            if (b.id !== blockId) return b;
            const parts = Array.isArray(b.parts) ? b.parts : [];
            return {...b, parts: [...parts, {kind: 'text', value}]};
        }));
    }, []);

    // Add an input segment to current block's template
    const handleAddInput = useCallback((blockId) => {
        const name = (window.prompt('输入参数名 (仅 a-z, A-Z):') || '').trim();
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
            window.alert('参数名格式不正确（仅字母数字下划线，开头必须是字母）');
            return;
        }
        setCustomBlocks(prev => prev.map(b => {
            if (b.id !== blockId) return b;
            const parts = Array.isArray(b.parts) ? b.parts : [];
            return {...b, parts: [...parts, {kind: 'input', name, inputType: 'String'}]};
        }));
    }, []);

    // Field-editor handlers (CB-ExtGallary style)
    const handleAddField = useCallback((blockId, kind) => {
        setCustomBlocks(prev => prev.map(b => {
            if (b.id !== blockId) return b;
            const fields = Array.isArray(b.fields) ? b.fields : [];
            const idx = fields.length;
            const newField = kind === 'label'
                ? {kind: 'label', text: '标签' + idx, name: 'F' + idx}
                : kind === 'number'
                    ? {kind: 'number', text: '数字' + idx, default: '0', name: 'F' + idx}
                    : kind === 'boolean'
                        ? {kind: 'boolean', text: '布尔' + idx, default: 'true', name: 'F' + idx}
                        : {kind: 'text', text: '文本' + idx, name: 'F' + idx};
            return {...b, fields: [...fields, newField]};
        }));
    }, []);

    const handleUpdateField = useCallback((blockId, idx, updates) => {
        setCustomBlocks(prev => prev.map(b => {
            if (b.id !== blockId) return b;
            const fields = Array.isArray(b.fields) ? b.fields : [];
            return {...b, fields: fields.map((f, i) => i === idx ? {...f, ...updates} : f)};
        }));
    }, []);

    const handleRemoveField = useCallback((blockId, idx) => {
        setCustomBlocks(prev => prev.map(b => {
            if (b.id !== blockId) return b;
            const fields = Array.isArray(b.fields) ? b.fields : [];
            return {...b, fields: fields.filter((_, i) => i !== idx)};
        }));
    }, []);

    // ── AI 工具宿主：把扩展编辑器的操作面暴露给内置 AI 插件 ──
    // nova-patch.js 会把原版 Nova 的「Scratch 项目 DSL」工具集替换成扩展编辑器
    // 工具集（getExtensionInfo / listCustomBlocks / addBlock / updateBlock /
    // deleteBlock / setExtensionInfo ...），并把工具派发重定向到
    // window.__extEditorAiToolHost → 这里实现的 window.__extEditorAI。
    // 依赖数组覆盖所有被读取的状态，保证 AI 每一轮调用都拿到最新值。
    useEffect(() => {
        const HEX_RE = /^#[0-9a-fA-F]{6}$/;
        const BLOCK_TYPES = ['command', 'reporter', 'boolean', 'hat'];
        const pickHex = (v) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : '');

        const findBlock = (key) => {
            const k = String(key == null ? '' : key).trim();
            if (!k) return null;
            return customBlocks.find(b => b.id === k) ||
                customBlocks.find(b => (b.name || '').trim() === k) ||
                null;
        };

        const describe = (b, idx) => ({
            id: b.id,
            name: b.name || ('我的积木 ' + (idx + 1)),
            opcode: (b.id || 'block').replace(/[^a-zA-Z0-9]/g, '_'),
            blockType: b.blockType || 'command',
            color: resolveBlockColour(b, extColor1Ref.current),
            isAsync: !!b.isAsync,
            filterSprite: b.filterSprite !== false,
            filterStage: b.filterStage !== false,
            arguments: (Array.isArray(b.parts) ? b.parts : [])
                .filter(p => p && p.kind === 'input' && p.name)
                .map(p => ({name: p.name, type: p.inputType === 'Number' ? 'number' : 'string'})),
            text: (Array.isArray(b.parts) && b.parts.length
                ? b.parts.map(p => (p.kind === 'text' ? p.value : '[' + p.name + ']')).join('')
                : (b.name || ''))
        });

        const api = {
            getEditorGuide() {
                return {
                    success: true,
                    editor: 'ForgeExt（TurboWarp 扩展可视化制作器）',
                    output: '独立 TurboWarp 扩展源码：getInfo() + blocks[] + Scratch.extensions.register',
                    blockTypes: {
                        command: '堆叠块（按顺序执行）',
                        reporter: '圆形返回值块',
                        boolean: '六边形布尔块',
                        hat: '事件帽块（触发脚本）'
                    },
                    rules: [
                        '积木文案里的命名参数写成 [name]，并且必须有同名 arguments 项，否则 TurboWarp 会静默丢弃该参数，积木渲染成空白。',
                        '颜色必须是 #RRGGBB 十六进制字符串；积木未设色时继承扩展 color1。',
                        'isAsync 只用于实现体里含 await 的积木，漏标会导致该积木静默失效。',
                        '扩展 id 只允许字母和数字（scratch-vm 限制），会作为 getInfo().id 与生成的类名。'
                    ],
                    workspace: '画布上真实摆放的积木与注释（与「积木定义」是两回事）：listToolboxBlocks（查工具箱里所有可用积木，20 分类 108 块）/ listWorkspaceBlocks（查画布现状）/ addWorkspaceBlock（放一块）/ deleteWorkspaceBlock（删一块）/ moveWorkspaceBlock（挪位置）/ connectWorkspaceBlocks（把一块接进另一块的插槽，搭逻辑的关键）/ addWorkspaceComment / updateWorkspaceComment / deleteWorkspaceComment（注释增删改）',
                    blockArguments: '读写画布积木的参数值：inspectWorkspaceBlock（查参数名与当前值）/ setWorkspaceBlockValue（填值）。「说 …」「移动 … 步」刚放下时参数是空的，必须用 setWorkspaceBlockValue 填进去才有意义。',
                    askUser: '需要用户拍板时（配色、命名、结构选型、二选一）调用 askUser 弹选择框，用户可选项或自己输入。它会一直等到用户作答才返回。',
                    tools: ['getExtensionInfo', 'listCustomBlocks', 'getCurrentBlock',
                        'getGeneratedCode', 'addBlock', 'updateBlock', 'deleteBlock',
                        'setExtensionInfo', 'listToolboxBlocks', 'listWorkspaceBlocks',
                        'addWorkspaceBlock', 'deleteWorkspaceBlock', 'moveWorkspaceBlock',
                        'connectWorkspaceBlocks', 'addWorkspaceComment', 'updateWorkspaceComment',
                        'deleteWorkspaceComment', 'inspectWorkspaceBlock', 'setWorkspaceBlockValue',
                        'askUser']
                };
            },

            getExtensionInfo() {
                return {success: true, extension: Object.assign({}, extInfo, {blockCount: customBlocks.length})};
            },

            listCustomBlocks() {
                return {
                    success: true,
                    count: customBlocks.length,
                    currentBlockId: currentBlockId,
                    blocks: customBlocks.map(describe)
                };
            },

            getCurrentBlock() {
                const idx = customBlocks.findIndex(b => b.id === currentBlockId);
                if (idx < 0) return {success: false, error: '当前没有选中的积木'};
                return {success: true, block: describe(customBlocks[idx], idx)};
            },

            getGeneratedCode() {
                const code = exportableCode || generatedCode || '';
                return {success: true, chars: code.length, code: code};
            },

            addBlock(args) {
                const a = args || {};
                const name = String(a.name == null ? '' : a.name).trim();
                if (!name) return {success: false, error: 'addBlock 需要 name（积木显示名）'};
                const blockType = BLOCK_TYPES.indexOf(a.blockType) >= 0 ? a.blockType : 'command';
                const colour = pickHex(a.color);
                const id = 'block_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                const entry = {
                    id: id, name: name, xml: null, blockType: blockType,
                    isTerminal: false,
                    isAsync: !!a.isAsync,
                    attachAllThreads: false,
                    filterSprite: a.filterSprite !== false,
                    filterStage: a.filterStage !== false,
                    icon: '', colour: colour
                };
                setCustomBlocks(prev => [...prev, entry]);
                currentBlockRef.current = id;
                setCurrentBlockId(id);
                if (workspaceRef.current) {
                    const B = window._extBuilderBlockly || window.Blockly || {};
                    addStarterBlocks(workspaceRef.current, B, name, id, blockType, colour);
                    const created = findBlockByCustomId(workspaceRef.current, id);
                    if (created && workspaceRef.current.select) {
                        workspaceRef.current.select(created);
                    }
                }
                return {
                    success: true, id: id, name: name, blockType: blockType,
                    color: resolveBlockColour(entry, extColor1Ref.current),
                    message: '已新增积木「' + name + '」并画到工作区'
                };
            },

            updateBlock(args) {
                const a = args || {};
                const target = findBlock(a.block);
                if (!target) return {success: false, error: '未找到积木：' + String(a.block == null ? '' : a.block)};
                const updates = {};
                if (a.name != null) {
                    const n = String(a.name).trim();
                    if (n) updates.name = n;
                }
                if (a.blockType != null && BLOCK_TYPES.indexOf(a.blockType) >= 0) updates.blockType = a.blockType;
                if (a.color != null) updates.colour = pickHex(a.color);
                if (a.isAsync != null) updates.isAsync = !!a.isAsync;
                if (a.filterSprite != null) updates.filterSprite = !!a.filterSprite;
                if (a.filterStage != null) updates.filterStage = !!a.filterStage;
                if (!Object.keys(updates).length) return {success: false, error: '没有可更新的字段'};
                handleUpdateBlock(target.id, updates);
                return {
                    success: true, id: target.id, updated: Object.keys(updates),
                    message: '已更新积木「' + (updates.name || target.name) + '」'
                };
            },

            deleteBlock(args) {
                const a = args || {};
                const target = findBlock(a.block);
                if (!target) return {success: false, error: '未找到积木：' + String(a.block == null ? '' : a.block)};
                if (customBlocks.length <= 1) return {success: false, error: '至少要保留一个积木，无法删除'};
                handleDeleteBlock(target.id);
                return {success: true, id: target.id, message: '已删除积木「' + (target.name || target.id) + '」'};
            },

            setExtensionInfo(args) {
                const a = args || {};
                const next = Object.assign({}, extInfo);
                const changed = [];
                if (a.id != null) {
                    const id = String(a.id).toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (id) { next.id = id; changed.push('id'); }
                }
                if (a.name != null) {
                    const n = String(a.name).trim();
                    if (n) { next.name = n; changed.push('name'); }
                }
                if (a.color1 != null) {
                    const c = pickHex(a.color1);
                    if (c) {
                        next.color1 = c;
                        next.color2 = darkenHex(c, 0.85);
                        next.color3 = darkenHex(c, 0.7);
                        changed.push('color1', 'color2', 'color3');
                    }
                }
                if (a.color2 != null) { const c = pickHex(a.color2); if (c) { next.color2 = c; changed.push('color2'); } }
                if (a.color3 != null) { const c = pickHex(a.color3); if (c) { next.color3 = c; changed.push('color3'); } }
                if (a.description != null) { next.description = String(a.description); changed.push('description'); }
                if (a.author != null) { next.author = String(a.author); changed.push('author'); }
                if (a.license != null) { next.license = String(a.license); changed.push('license'); }
                if (a.docsUrl != null) { next.docsUrl = String(a.docsUrl); changed.push('docsUrl'); }
                if (!changed.length) return {success: false, error: '没有可更新的字段'};
                setExtInfo(next);
                return {success: true, updated: changed, extension: next};
            },

            // ─────────── 工作区（画布）操作 ───────────
            // 上面那批工具操作的是「积木定义」（customBlocks 列表）；
            // 这一批操作的是画布上真实摆放的 Blockly 积木与注释，
            // 让 AI 能像用户一样把工具箱里的块拖到画布上、删掉、贴便签。

            /** 从 BLOCK_DEFINITIONS 里取一个可读的块名（message0 去掉 %1 占位）。 */
            _toolboxLabel(type) {
                const def = BLOCK_DEFINITIONS[type] || {};
                const raw = String(def.message0 == null ? '' : def.message0);
                const label = raw.replace(/%\d+/g, '…').replace(/\s+/g, ' ').trim();
                return label || type;
            },

            listToolboxBlocks(args) {
                const a = args || {};
                const want = a.category ? String(a.category).trim() : '';
                const categories = [];
                (TOOLBOX_CONFIG.contents || []).forEach((cat) => {
                    const blocks = (cat.contents || [])
                        .filter(c => c && c.kind === 'block' && c.type)
                        .map(c => {
                            const def = BLOCK_DEFINITIONS[c.type] || {};
                            return {
                                type: c.type,
                                label: api._toolboxLabel(c.type),
                                shape: def.id || '',
                                tooltip: def.tooltip || ''
                            };
                        });
                    if (blocks.length) {
                        categories.push({category: cat.name, count: blocks.length, blocks: blocks});
                    }
                });
                const filtered = want
                    ? categories.filter(c => c.category.indexOf(want) >= 0)
                    : categories;
                return {
                    success: true,
                    categoryCount: filtered.length,
                    blockCount: filtered.reduce((n, c) => n + c.count, 0),
                    categories: filtered
                };
            },

            listWorkspaceBlocks() {
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const tops = ws.getTopBlocks ? ws.getTopBlocks(true) : [];
                const blocks = tops.map(b => {
                    const xy = (b.getRelativeToSurfaceXY && b.getRelativeToSurfaceXY()) || {x: 0, y: 0};
                    let text = '';
                    try { text = String(b.toString ? b.toString() : '').replace(/\s+/g, ' ').trim(); } catch (e) { /* 忽略 */ }
                    return {
                        id: b.id,
                        type: b.type,
                        label: api._toolboxLabel(b.type),
                        text: text,
                        x: Math.round(xy.x),
                        y: Math.round(xy.y),
                        isBlockDefine: b.type === 'block_define'
                    };
                });
                const comments = (ws.getTopComments ? ws.getTopComments(true) : [])
                    .map(c => ({
                        id: c.id,
                        text: String(c.getText ? c.getText() : ''),
                        x: Math.round((c.getRelativeToSurfaceXY && c.getRelativeToSurfaceXY().x) || 0),
                        y: Math.round((c.getRelativeToSurfaceXY && c.getRelativeToSurfaceXY().y) || 0)
                    }));
                return {success: true, blockCount: blocks.length, blocks: blocks, commentCount: comments.length, comments: comments};
            },

            /** 把画布上已有积木整体下移后返回下一个可用的空位 y。 */
            _nextSlotY(ws, exclude) {
                const tops = ws.getTopBlocks ? ws.getTopBlocks(true) : [];
                let bottom = 40;
                tops.forEach(b => {
                    if (b === exclude) return;
                    const y = (b.getRelativeToSurfaceXY && b.getRelativeToSurfaceXY().y) || 0;
                    const h = b.height || 40;
                    bottom = Math.max(bottom, y + h + 24);
                });
                return bottom;
            },

            addWorkspaceBlock(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const B = window._extBuilderBlockly || window.Blockly || {};
                let type = String(a.type == null ? '' : a.type).trim();
                if (!type) return {success: false, error: 'addWorkspaceBlock 需要 type（积木类型，先用 listToolboxBlocks 查）'};
                // block_define 是「积木定义」卡片，由 customBlocks 列表驱动（addBlock /
                // deleteBlock 管）。在画布上手动加一张会让它和工作区失去对应关系，
                // 变成一块点了没反应、又删不掉的僵尸卡。这里直接拒绝并给出正确工具。
                if (type === 'block_define') {
                    return {success: false, error: 'block_define 是积木定义卡片，请用 addBlock 新增积木，不要直接放到画布上'};
                }
                // 模糊匹配：AI 写出的类型名常混用大小写（motion_movesteps vs
                // motion_moveSteps）。B.Blocks 里大小写注册不一致 —— 有的两种
                // 都有，有的只有驼峰版 —— 精确匹配失败时按「小写 → 原样」
                // 顺序做一次规范化重试，避免静默失败。
                if (!(B.Blocks && B.Blocks[type])) {
                    const candidates = [
                        type.toLowerCase(),
                        type.replace(/[-_\s]+([a-z])/g, (m0, c) => c.toUpperCase()) // snake/case → camelCase
                    ];
                    const hit = candidates.find(c => c !== type && B.Blocks && B.Blocks[c]);
                    if (hit) type = hit;
                    else return {success: false, error: '未知积木类型：' + type + '（先用 listToolboxBlocks 查可用类型）'};
                }

                let blk = null;
                try {
                    const shadows = PLACEHOLDER_SHADOWS[type];
                    if (shadows && B.Xml && B.Xml.domToWorkspace) {
                        // 走 XML：让 toolbox 里声明的 shadow 占位（math_number / text 等）
                        // 一起生成，否则带 input_value 的块会留个空槽，看上去像缺参数。
                        const valueXml = Object.keys(shadows).map(name => {
                            const s = shadows[name];
                            return '<value name="' + name + '"><shadow type="' + s.type +
                                '"><field name="' + s.field + '">' + s.value + '</field></shadow></value>';
                        }).join('');
                        const xmlStr = '<xml xmlns="https://developers.google.com/blockly/xml">' +
                            '<block type="' + type + '">' + valueXml + '</block></xml>';
                        const dom = new DOMParser().parseFromString(xmlStr, 'text/xml').documentElement;
                        const created = B.Xml.domToWorkspace(dom, ws);
                        // 坑：scratch-blocks 的 domToWorkspace 返回的是 **block id 字符串
                        // 数组**（源码里 c.push(m.id)），不是 block 对象。早先直接取
                        // created[0] 当 block 用，导致带 shadow 的块（looks_say 等）
                        // 返回 id=undefined、坐标也没能移动。这里统一按 id 反查回对象。
                        const first = created && created[0];
                        if (first && typeof first === 'object') {
                            blk = first;
                        } else if (first && ws.getBlockById) {
                            blk = ws.getBlockById(first);
                        }
                        if (!blk && first) {
                            // 极端兜底：块确实建出来了但反查失败，至少保住 id
                            blk = {id: String(first), type: type};
                        }
                    } else {
                        blk = ws.newBlock(type);
                        if (blk) { blk.initSvg(); blk.render(); }
                    }
                } catch (e) {
                    return {success: false, error: '放置积木失败：' + ((e && e.message) || e)};
                }
                if (!blk) return {success: false, error: '放置积木失败：' + type};

                const x = a.x != null && isFinite(Number(a.x)) ? Number(a.x) : 60;
                const y = a.y != null && isFinite(Number(a.y)) ? Number(a.y) : api._nextSlotY(ws, blk);
                try {
                    if (blk.moveBy && blk.getRelativeToSurfaceXY) {
                        const cur = blk.getRelativeToSurfaceXY() || {x: 0, y: 0};
                        blk.moveBy(x - cur.x, y - cur.y);
                    }
                    if (ws.render) ws.render();
                } catch (e) { /* 定位失败不影响块已存在 */ }
                // 默认不抢镜头：AI 连续放十几个块时，每次都居中会让画布疯狂跳动。
                // 需要让用户看到刚放的那块时，显式传 focus: true。
                if (a.focus === true && ws.centerOnBlock && blk.id) {
                    try { ws.centerOnBlock(blk.id); } catch (e) { /* 忽略 */ }
                }
                return {
                    success: true,
                    id: blk.id,
                    type: type,
                    label: api._toolboxLabel(type),
                    x: Math.round(x),
                    y: Math.round(y),
                    message: '已把「' + api._toolboxLabel(type) + '」放到画布上'
                };
            },

            deleteWorkspaceBlock(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const id = String(a.id == null ? '' : a.id).trim();
                if (!id) return {success: false, error: 'deleteWorkspaceBlock 需要 id（先用 listWorkspaceBlocks 查）'};
                const blk = ws.getBlockById ? ws.getBlockById(id) : null;
                if (!blk) return {success: false, error: '画布上没找到这个积木：' + id};
                // block_define 是「积木定义」卡片，和 customBlocks 列表一一对应。
                // 直接 dispose 掉会留下一条没有卡片、点不着也删不掉的僵尸定义，
                // 所以这里拒绝并指向正确的工具（deleteBlock 会同时收掉卡片）。
                if (blk.type === 'block_define') {
                    return {success: false, error: 'block_define 是积木定义卡片，请用 deleteBlock 删除对应的积木定义'};
                }
                const info = {id: blk.id, type: blk.type, label: api._toolboxLabel(blk.type)};
                try {
                    blk.dispose(false);
                } catch (e) {
                    return {success: false, error: '删除失败：' + ((e && e.message) || e)};
                }
                return {
                    success: true, id: info.id, type: info.type,
                    message: '已从画布删除「' + info.label + '」'
                };
            },

            addWorkspaceComment(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const B = window._extBuilderBlockly || window.Blockly || {};
                const text = a.text == null ? '' : String(a.text);
                if (!text.trim()) return {success: false, error: 'addWorkspaceComment 需要 text（注释内容）'};
                if (!B.WorkspaceCommentSvg) return {success: false, error: '当前 Blockly 不支持工作区注释'};
                try {
                    const C = B.WorkspaceCommentSvg;
                    const size = C.DEFAULT_SIZE || 200;
                    const comment = new C(ws, text, size, size, false);
                    const x = a.x != null && isFinite(Number(a.x)) ? Number(a.x) : 40;
                    const y = a.y != null && isFinite(Number(a.y)) ? Number(a.y) : api._nextSlotY(ws, null);
                    comment.moveBy(x, y);
                    if (ws.rendered) {
                        comment.initSvg();
                        comment.render(false);
                    }
                    if (B.WorkspaceComment && B.WorkspaceComment.fireCreateEvent) {
                        B.WorkspaceComment.fireCreateEvent(comment);
                    }
                    return {
                        success: true, id: comment.id, text: text,
                        x: Math.round(x), y: Math.round(y),
                        message: '已在画布上添加注释'
                    };
                } catch (e) {
                    return {success: false, error: '添加注释失败：' + ((e && e.message) || e)};
                }
            },

            /** 按 id 找画布上的注释（注释不是 block，得走 getCommentById）。 */
            _findComment(id) {
                const ws = workspaceRef.current;
                if (!ws || !ws.getCommentById) return null;
                try { return ws.getCommentById(id) || null; } catch (e) { return null; }
            },

            updateWorkspaceComment(args) {
                const a = args || {};
                if (!workspaceRef.current) return {success: false, error: '工作区尚未就绪'};
                const id = String(a.id == null ? '' : a.id).trim();
                if (!id) return {success: false, error: 'updateWorkspaceComment 需要 id（先用 listWorkspaceBlocks 查）'};
                const comment = api._findComment(id);
                if (!comment) return {success: false, error: '画布上没找到这条注释：' + id};
                const changed = [];
                if (a.text != null) {
                    const text = String(a.text);
                    if (!text.trim()) return {success: false, error: '注释内容不能为空（改文字时 text 必填）'};
                    try { comment.setText(text); } catch (e) {
                        return {success: false, error: '改注释文字失败：' + ((e && e.message) || e)};
                    }
                    changed.push('text');
                }
                if (a.x != null || a.y != null) {
                    try {
                        const cur = (comment.getRelativeToSurfaceXY && comment.getRelativeToSurfaceXY()) || {x: 0, y: 0};
                        const nx = a.x != null && isFinite(Number(a.x)) ? Number(a.x) : cur.x;
                        const ny = a.y != null && isFinite(Number(a.y)) ? Number(a.y) : cur.y;
                        comment.moveBy(nx - cur.x, ny - cur.y);
                        changed.push('position');
                    } catch (e) { /* 只挪位置失败不算致命 */ }
                }
                if (!changed.length) return {success: false, error: '没有可更新的字段（text / x / y）'};
                try { if (comment.render) comment.render(false); } catch (e) { /* 忽略 */ }
                let now = '';
                try { now = String(comment.getText ? comment.getText() : ''); } catch (e) { /* 忽略 */ }
                return {success: true, id: id, updated: changed, text: now, message: '已更新注释'};
            },

            deleteWorkspaceComment(args) {
                const a = args || {};
                if (!workspaceRef.current) return {success: false, error: '工作区尚未就绪'};
                const id = String(a.id == null ? '' : a.id).trim();
                if (!id) return {success: false, error: 'deleteWorkspaceComment 需要 id（先用 listWorkspaceBlocks 查）'};
                const comment = api._findComment(id);
                if (!comment) return {success: false, error: '画布上没找到这条注释：' + id};
                let text = '';
                try { text = String(comment.getText ? comment.getText() : ''); } catch (e) { /* 忽略 */ }
                try {
                    comment.dispose();
                } catch (e) {
                    return {success: false, error: '删除注释失败：' + ((e && e.message) || e)};
                }
                return {success: true, id: id, message: '已删除注释「' + text.slice(0, 30) + '」'};
            },

            /**
             * 把一块积木接到另一块的插槽上 —— 搭真实逻辑的关键一步。
             * 没有它，AI 只能摆出一排互不相干的空壳（「如果 …」永远没有条件）。
             */
            connectWorkspaceBlocks(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const parentId = String(a.parent == null ? '' : a.parent).trim();
                const childId = String(a.child == null ? '' : a.child).trim();
                if (!parentId || !childId) return {success: false, error: 'connectWorkspaceBlocks 需要 parent 和 child（都是 listWorkspaceBlocks 里的 id）'};
                if (parentId === childId) return {success: false, error: '不能把积木接到自己身上'};
                const parent = ws.getBlockById ? ws.getBlockById(parentId) : null;
                if (!parent) return {success: false, error: '没找到父积木：' + parentId};
                const child = ws.getBlockById ? ws.getBlockById(childId) : null;
                if (!child) return {success: false, error: '没找到子积木：' + childId};

                // 子块要么是 reporter/boolean（outputConnection），要么是语句块（previousConnection）
                const childConn = child.outputConnection || child.previousConnection;
                if (!childConn) return {success: false, error: '积木「' + child.type + '」没有可连接的接口'};

                // 先断开 child 原有的连线，避免「已经连着别处」导致 connect 静默失败
                try {
                    if (childConn.isConnected && childConn.isConnected()) childConn.disconnect();
                    if (child.outputConnection && child.outputConnection.isConnected && child.outputConnection.isConnected()) {
                        child.outputConnection.disconnect();
                    }
                } catch (e) { /* 忽略 */ }

                const attempt = (conn) => {
                    if (!conn) return false;
                    try {
                        if (typeof conn.checkType_ === 'function' && !conn.checkType_(childConn)) return false;
                    } catch (e) { return false; }
                    try {
                        conn.connect(childConn);
                        if (conn.targetBlock && conn.targetBlock() === child) {
                            try { if (parent.render) parent.render(); } catch (e2) { /* 忽略 */ }
                            return true;
                        }
                    } catch (e) { /* 试下一个 */ }
                    return false;
                };

                const inputName = a.input == null ? '' : String(a.input).trim();
                if (inputName) {
                    let input = null;
                    (parent.inputList || []).forEach((inp) => { if (inp.name === inputName) input = inp; });
                    if (!input) {
                        const names = [];
                        (parent.inputList || []).forEach((inp) => { if (inp.name && inp.connection) names.push(inp.name); });
                        return {success: false, error: '积木「' + parent.type + '」上没有插槽「' + inputName + '」' + (names.length ? '（可用：' + names.join(' / ') + '）' : '')};
                    }
                    if (!attempt(input.connection)) {
                        return {success: false, error: '「' + child.type + '」接不进「' + parent.type + '」的「' + inputName + '」插槽（形状或类型不匹配）'};
                    }
                    return {success: true, parent: parentId, child: childId, input: inputName, message: '已把「' + api._toolboxLabel(child.type) + '」接进「' + api._toolboxLabel(parent.type) + '」的 ' + inputName};
                }

                // 没指定插槽：先试值插槽，再试语句串联
                const valueInputs = [];
                (parent.inputList || []).forEach((inp) => { if (inp.name && inp.connection) valueInputs.push(inp); });
                for (let i = 0; i < valueInputs.length; i++) {
                    if (attempt(valueInputs[i].connection)) {
                        return {success: true, parent: parentId, child: childId, input: valueInputs[i].name, message: '已把「' + api._toolboxLabel(child.type) + '」接进「' + api._toolboxLabel(parent.type) + '」的 ' + valueInputs[i].name};
                    }
                }
                if (child.previousConnection && parent.nextConnection && attempt(parent.nextConnection)) {
                    return {success: true, parent: parentId, child: childId, input: 'next', message: '已把「' + api._toolboxLabel(child.type) + '」串到「' + api._toolboxLabel(parent.type) + '」下面'};
                }
                return {success: false, error: '这两块积木接不上（形状不匹配）：' + parent.type + ' ← ' + child.type + '。用 inspectWorkspaceBlock 看插槽名，或用 listToolboxBlocks 换一个形状合适的块'};
            },

            moveWorkspaceBlock(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const id = String(a.id == null ? '' : a.id).trim();
                if (!id) return {success: false, error: 'moveWorkspaceBlock 需要 id'};
                const blk = ws.getBlockById ? ws.getBlockById(id) : null;
                if (!blk) return {success: false, error: '画布上没找到这个积木：' + id};
                if (a.x == null && a.y == null) return {success: false, error: 'moveWorkspaceBlock 需要 x 或 y'};
                try {
                    const cur = (blk.getRelativeToSurfaceXY && blk.getRelativeToSurfaceXY()) || {x: 0, y: 0};
                    const nx = a.x != null && isFinite(Number(a.x)) ? Number(a.x) : cur.x;
                    const ny = a.y != null && isFinite(Number(a.y)) ? Number(a.y) : cur.y;
                    blk.moveBy(nx - cur.x, ny - cur.y);
                    if (ws.render) ws.render();
                    return {success: true, id: id, x: Math.round(nx), y: Math.round(ny), message: '已把「' + api._toolboxLabel(blk.type) + '」移到 ' + Math.round(nx) + ',' + Math.round(ny)};
                } catch (e) {
                    return {success: false, error: '移动失败：' + ((e && e.message) || e)};
                }
            },

            // ─────────── 读写画布积木的参数值 ───────────
            // addWorkspaceBlock 只摆出空壳（「说 …」「移动 … 步」）。
            // 这几个工具让 AI 把参数真正填进去，搭出有意义的逻辑，
            // 而不是留一堆默认占位。

            /** 取 block 上第一个可用字段名（math_number→NUM，text→TEXT，logic_boolean→BOOL）。 */
            _firstFieldName(blk) {
                if (!blk || !blk.inputList) return '';
                for (let i = 0; i < blk.inputList.length; i++) {
                    const row = (blk.inputList[i] && blk.inputList[i].fieldRow) || [];
                    for (let j = 0; j < row.length; j++) {
                        if (row[j] && row[j].name) return row[j].name;
                    }
                }
                return '';
            },

            /** 读一个占位块（shadow）里存的值。 */
            _readBlockValue(blk) {
                if (!blk) return '';
                const fn = api._firstFieldName(blk);
                if (!fn || !blk.getFieldValue) return '';
                try {
                    const v = blk.getFieldValue(fn);
                    return v == null ? '' : String(v);
                } catch (e) {
                    return '';
                }
            },

            /** 按插槽的 check 约束挑一个合适的占位块类型。 */
            _pickShadowType(input, hint) {
                const h = String(hint == null ? '' : hint).toLowerCase();
                if (h === 'number' || h === 'num') return 'math_number';
                if (h === 'boolean' || h === 'bool') return 'logic_boolean';
                if (h === 'text' || h === 'string') return 'text';
                let chk = null;
                try {
                    if (input && input.connection) {
                        chk = input.connection.check_ ||
                            (input.connection.getCheck && input.connection.getCheck());
                    }
                } catch (e) { /* 忽略 */ }
                const arr = Array.isArray(chk) ? chk : (chk ? [chk] : []);
                if (arr.indexOf('Boolean') >= 0) return 'logic_boolean';
                if (arr.indexOf('Number') >= 0) return 'math_number';
                return 'text';
            },

            /** 把值写进占位块，按块类型做类型转换。 */
            _writeBlockValue(blk, value) {
                const fn = api._firstFieldName(blk);
                if (!fn || !blk.setFieldValue) return false;
                let v = value;
                if (blk.type === 'math_number') {
                    const n = Number(value);
                    v = isFinite(n) ? n : 0;
                } else if (blk.type === 'logic_boolean') {
                    const t = value === true || value === 'true' || value === 'TRUE' || value === '是';
                    v = t ? 'TRUE' : 'FALSE';
                } else {
                    v = String(value == null ? '' : value);
                }
                try {
                    blk.setFieldValue(v, fn);
                } catch (e) {
                    try { blk.setFieldValue(String(v), fn); } catch (e2) { return false; }
                }
                return true;
            },

            inspectWorkspaceBlock(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const id = String(a.id == null ? '' : a.id).trim();
                if (!id) return {success: false, error: 'inspectWorkspaceBlock 需要 id（先用 listWorkspaceBlocks 查）'};
                const blk = ws.getBlockById ? ws.getBlockById(id) : null;
                if (!blk) return {success: false, error: '画布上没找到这个积木：' + id};

                const argList = [];
                (blk.inputList || []).forEach((inp) => {
                    // 内联字段：下拉 / 文本 / 数字
                    (inp.fieldRow || []).forEach((f) => {
                        if (!f || !f.name) return;
                        let cur = '';
                        try { cur = f.getValue(); } catch (e) { /* 忽略 */ }
                        argList.push({
                            name: f.name,
                            kind: 'field',
                            current: cur == null ? '' : String(cur),
                            writable: true
                        });
                    });
                    // 插槽（input_value）：里面可能是占位块，也可能是真实积木
                    if (inp.name && inp.connection && inp.connection.targetBlock) {
                        const target = inp.connection.targetBlock();
                        const isShadow = !!(target && target.isShadow && target.isShadow());
                        argList.push({
                            name: inp.name,
                            kind: 'input',
                            current: target ? (isShadow ? api._readBlockValue(target) : '(已被积木占用)') : '',
                            shadowType: isShadow ? target.type : '',
                            writable: !target || isShadow
                        });
                    }
                });

                return {
                    success: true,
                    id: blk.id,
                    type: blk.type,
                    label: api._toolboxLabel(blk.type),
                    argumentCount: argList.length,
                    arguments: argList,
                    hint: '用 setWorkspaceBlockValue({id, name, value}) 写入；name 就是上面 arguments 里的名字。'
                };
            },

            setWorkspaceBlockValue(args) {
                const a = args || {};
                const ws = workspaceRef.current;
                if (!ws) return {success: false, error: '工作区尚未就绪'};
                const id = String(a.id == null ? '' : a.id).trim();
                if (!id) return {success: false, error: 'setWorkspaceBlockValue 需要 id（先用 listWorkspaceBlocks 查）'};
                const name = String(a.name == null ? '' : a.name).trim();
                if (!name) return {success: false, error: 'setWorkspaceBlockValue 需要 name（参数名，先用 inspectWorkspaceBlock 查）'};
                if (a.value == null) return {success: false, error: 'setWorkspaceBlockValue 需要 value'};
                const blk = ws.getBlockById ? ws.getBlockById(id) : null;
                if (!blk) return {success: false, error: '画布上没找到这个积木：' + id};

                // 1) 先当内联字段处理（下拉 / 文本 / 数字）
                let field = null;
                (blk.inputList || []).forEach((inp) => {
                    (inp.fieldRow || []).forEach((f) => { if (f && f.name === name) field = f; });
                });
                if (field) {
                    let before = '';
                    try { before = field.getValue(); } catch (e) { /* 忽略 */ }
                    try {
                        field.setValue(String(a.value));
                    } catch (e) {
                        return {success: false, error: '写入字段失败：' + ((e && e.message) || e)};
                    }
                    if (blk.render) { try { blk.render(); } catch (e) { /* 忽略 */ } }
                    // after 必须是「从块里回读到的值」，不是回显输入值。
                    // 下拉字段会拒绝非法选项、数字字段会规范化精度，
                    // 回显输入会让 AI 以为写成功而实际是旧值。
                    let after = '';
                    try { after = field.getValue(); } catch (e) { /* 忽略 */ }
                    const afterStr = after == null ? '' : String(after);
                    // 比较忽略大小写：scratch-blocks 的下拉字段（logic_boolean）
                    // 声明值是 'TRUE'/'FALSE'，回读却是 'true'/'false'，
                    // 严格相等会把一次成功的写入误报成 applied:false。
                    const appliedSame = String(afterStr).toLowerCase() === String(a.value).toLowerCase();
                    return {
                        success: true, kind: 'field', id: id, name: name,
                        before: before == null ? '' : String(before),
                        after: afterStr,
                        requested: String(a.value),
                        applied: appliedSame,
                        message: '已把「' + name + '」设为 ' + afterStr
                    };
                }

                // 2) 再当插槽（input_value）处理
                let input = null;
                (blk.inputList || []).forEach((inp) => {
                    if (inp.name === name && inp.connection) input = inp;
                });
                if (!input) {
                    return {success: false, error: '这个积木上没有名为「' + name + '」的参数（先用 inspectWorkspaceBlock 查参数名）'};
                }

                const conn = input.connection;
                const target = conn.targetBlock ? conn.targetBlock() : null;
                const isShadow = !!(target && target.isShadow && target.isShadow());

                // 已经接了一块真实积木：不覆盖用户/AI 的连法，明确拒绝。
                if (target && !isShadow) {
                    return {
                        success: false,
                        error: '插槽「' + name + '」里已经接了一块积木（' + target.type + '），请先把它移走再设值'
                    };
                }

                if (target) {
                    // 已有占位块：直接改它的值
                    if (!api._writeBlockValue(target, a.value)) {
                        return {success: false, error: '写入插槽失败：占位块 ' + target.type + ' 没有可用字段'};
                    }
                    if (blk.render) { try { blk.render(); } catch (e) { /* 忽略 */ } }
                    // 回读实际落地值（数字占位块会做 parseFloat 规范化）
                    const afterStr = api._readBlockValue(target);
                    return {
                        success: true, kind: 'input', id: id, name: name,
                        shadowType: target.type, after: afterStr,
                        requested: String(a.value),
                        applied: String(afterStr).toLowerCase() === String(a.value).toLowerCase(),
                        message: '已把「' + name + '」设为 ' + afterStr
                    };
                }

                // 插槽是空的：新建一个占位块连上去
                const B = window._extBuilderBlockly || window.Blockly || {};
                const shadowType = api._pickShadowType(input, a.shadowType || a.valueType);
                if (!(B.Blocks && B.Blocks[shadowType])) {
                    return {success: false, error: '无法创建占位块 ' + shadowType};
                }
                let sh = null;
                try {
                    sh = ws.newBlock(shadowType);
                    if (sh.setShadow) sh.setShadow(true);
                    if (sh.initSvg) sh.initSvg();
                    if (sh.render) sh.render();
                    conn.connect(sh.outputConnection);
                } catch (e) {
                    return {success: false, error: '创建占位块失败：' + ((e && e.message) || e)};
                }
                if (!api._writeBlockValue(sh, a.value)) {
                    return {success: false, error: '占位块已创建但写值失败：' + shadowType};
                }
                if (blk.render) { try { blk.render(); } catch (e) { /* 忽略 */ } }
                const afterStr = api._readBlockValue(sh);
                return {
                    success: true, kind: 'input', id: id, name: name,
                    shadowType: shadowType, after: afterStr,
                    requested: String(a.value),
                    applied: String(afterStr).toLowerCase() === String(a.value).toLowerCase(),
                    message: '已把「' + name + '」设为 ' + afterStr
                };
            },

            // ─────────── 询问条：让用户拍板 ───────────
            // 对齐 DeepSeek Harness 的 ask_user_question：
            //   · 询问条贴在 AI 面板「提示词输入框」上方，不再是挡屏的居中模态
            //   · 支持一次问多个问题（questions 数组，逐个作答，可回上一个）
            //   · 左下角显示「本次询问共 N 个问题 · 第 i / N 个」
            // 返回 Promise：插件侧的工具派发是 await 的，所以 AI 会一直等到
            // 用户作答再继续，不会自己瞎猜一个值。
            askUser(args) {
                const a = args || {};

                // 兼容两种入参：新的 questions 数组，以及旧的单问题 question/options。
                let raw = Array.isArray(a.questions) ? a.questions.slice() : [];
                if (!raw.length) {
                    const one = String(a.question == null ? '' : a.question).trim();
                    if (one) {
                        raw = [{
                            id: a.id,
                            header: a.header,
                            question: one,
                            options: a.options,
                            allowCustom: a.allowCustom,
                            multiSelect: a.multiSelect
                        }];
                    }
                }
                if (!raw.length) {
                    return {success: false, error: 'askUser 需要 questions（要问用户什么）'};
                }
                if (aiAskBarRef.current) {
                    return {success: false, error: '已经有一个询问条在等待用户作答，请等它关闭后再问'};
                }

                return new Promise((resolve) => {
                    let settled = false;
                    const done = (payload) => {
                        if (settled) return;
                        settled = true;
                        aiAskBarRef.current = null;
                        resolve(payload);
                    };
                    const bar = openAskBar(raw, {
                        onSubmit(answers) {
                            done({success: true, answers: answers, answer: answers.length === 1 ? answers[0].answer : answers.map(x => x.answer), raw: answers});
                        },
                        onCancel() {
                            done({success: false, cancelled: true, reason: '用户取消了选择'});
                        }
                    });
                    if (!bar) {
                        done({success: false, error: 'askUser 的问题列表为空'});
                        return;
                    }
                    aiAskBarRef.current = bar;
                    // 清理兜底：组件卸载 / 热更新时把 DOM 一起收掉
                    bar.el.__extAskCleanup = () => done({success: false, cancelled: true, reason: '询问条被销毁'});
                });
            }
        };

        window.__extEditorAI = api;
        return () => {
            if (window.__extEditorAI === api) {
                try { delete window.__extEditorAI; } catch (e) { window.__extEditorAI = null; }
            }
        };
    }, [customBlocks, currentBlockId, extInfo, exportableCode, generatedCode,
        handleUpdateBlock, handleDeleteBlock]);

    // Save block metadata (already applied via setters, this just confirms + shows summary)
    const handleSaveBlockMeta = useCallback((blockId) => {
        const block = customBlocks.find(b => b.id === blockId);
        if (!block) return;
        const parts = block.parts || [];
        const template = parts
            .map(p => p.kind === 'text' ? p.value : `[${p.name}]`)
            .join('');
        const summary = [
            `名称: ${block.name}`,
            `类型: ${block.blockType}`,
            `结尾: ${block.isTerminal ? '是' : '否'}`,
            `异步: ${block.isAsync ? '是' : '否'}`,
            `附加所有线程: ${block.attachAllThreads ? '是' : '否'}`,
            `在角色中显示: ${block.filterSprite ? '是' : '否'}`,
            `在舞台中显示: ${block.filterStage ? '是' : '否'}`,
            `图标: ${block.icon ? '已设置' : '无'}`,
            `模板: ${template || '(空)'}`
        ].join('\n');
        window.alert('积木已保存:\n\n' + summary);
    }, [customBlocks]);

    // Extension settings (creation) modal
    const handleOpenSettings = useCallback(() => {
        setSettingsDraft({...extInfo});
        setShowSettingsPanel(true);
        setSettingsTab('editor');
    }, [extInfo]);

    const handleCloseSettings = useCallback(() => {
        setShowSettingsPanel(false);
        setSettingsDraft(null);
        setSettingsMinimized(false);
        setSettingsMaximized(false);
    }, []);

    // ─── 设置悬浮框：拖动 / 拉伸 / 最大化 ───
    const settingsDragRef = useRef(null);
    const settingsResizeRef = useRef(null);
    const settingsResizeLayerRef = useRef(null);

    // 将拉伸层定位到面板当前 rect（覆盖面板边缘，手柄才贴边可点）
    const syncSettingsResizeLayerPos = useCallback(() => {
        const panel = settingsPanelRef.current;
        const layer = settingsResizeLayerRef.current;
        if (!panel || !layer) return;
        const rect = panel.getBoundingClientRect();
        layer.style.top = rect.top + 'px';
        layer.style.left = rect.left + 'px';
        layer.style.width = rect.width + 'px';
        layer.style.height = rect.height + 'px';
    }, []);

    const settingsSyncResizeLayer = useCallback(() => {
        const panel = settingsPanelRef.current;
        if (!panel) return;
        if (panel.style.display === 'none' || settingsMaximized) { setSettingsResizeLayerOn(false); return; }
        setSettingsResizeLayerOn(true);
    }, [settingsMaximized]);

    const handleSettingsHeaderMouseDown = useCallback((e) => {
        if (settingsMaximized) return;
        // 以下区域不触发拖拽：按钮 / tab / 表单控件 / 可滚动内容列表 / 拉伸手柄
        if (e.target.closest('.ext-float-btn')) return;
        if (e.target.closest('.ext-settings-tab')) return;
        if (e.target.closest('.ext-float-resize-handle')) return;
        if (e.target.closest('button, input, select, textarea, a, label, .ext-market-grid')) return;
        const panel = settingsPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        // 锁定宽度：防止 width:auto 被 content 撑开后右边缘贴屏
        const lockedWidth = panel.style.width || (panel.offsetWidth + 'px');
        settingsDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origLeft: rect.left,
            origTop: rect.top,
            lockedWidth: lockedWidth
        };
        e.preventDefault();
    }, [settingsMaximized]);

    const handleSettingsMouseMove = useCallback((e) => {
        const panel = settingsPanelRef.current;
        if (!panel) return;
        if (settingsDragRef.current) {
            const d = settingsDragRef.current;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            let newLeft = d.origLeft + dx;
            let newTop = d.origTop + dy;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 60));
            newLeft = Math.max(-panel.offsetWidth + 80, Math.min(newLeft, window.innerWidth - 80));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
            panel.style.width = d.lockedWidth || panel.style.width || (panel.offsetWidth + 'px');
            panel.style.transform = 'none';
            settingsSyncResizeLayer();
            syncSettingsResizeLayerPos();
        } else if (settingsResizeRef.current) {
            const d = settingsResizeRef.current;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            let newLeft = d.origLeft, newTop = d.origTop, newW = d.origW, newH = d.origH;
            const minW = 420, minH = 360;
            if (d.dir.indexOf('e') !== -1) newW = Math.max(minW, d.origW + dx);
            if (d.dir.indexOf('s') !== -1) newH = Math.max(minH, d.origH + dy);
            if (d.dir.indexOf('w') !== -1) { newW = Math.max(minW, d.origW - dx); newLeft = d.origLeft + (d.origW - newW); }
            if (d.dir.indexOf('n') !== -1) { newH = Math.max(minH, d.origH - dy); newTop = d.origTop + (d.origH - newH); }
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 40));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            panel.style.transform = 'none';
            settingsSyncResizeLayer();
            syncSettingsResizeLayerPos();
        }
    }, [settingsSyncResizeLayer]);

    const handleSettingsMouseUp = useCallback(() => {
        settingsDragRef.current = null;
        settingsResizeRef.current = null;
        setSettingsResizeLayerOn(false);
    }, []);

    const handleSettingsResizeDown = useCallback((dir) => (e) => {
        if (settingsMaximized) return;
        e.preventDefault();
        e.stopPropagation();
        const panel = settingsPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        settingsResizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, origW: rect.width, origH: rect.height };
        setSettingsResizeLayerOn(true);
    }, [settingsMaximized]);

    const handleSettingsToggleMax = useCallback(() => {
        const panel = settingsPanelRef.current;
        if (!panel) return;
        if (!settingsMaximized) {
            // Save current bounds for restore
            const rect = panel.getBoundingClientRect();
            settingsBoundsRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            // Clear inline positioning so CSS .maximized class takes over
            panel.style.top = '';
            panel.style.left = '';
            panel.style.right = '';
            panel.style.bottom = '';
            panel.style.width = '';
            panel.style.height = '';
            panel.style.transform = '';
            setSettingsMaximized(true);
        } else {
            // Restore saved bounds as inline styles
            if (settingsBoundsRef.current) {
                panel.style.top = settingsBoundsRef.current.top + 'px';
                panel.style.left = settingsBoundsRef.current.left + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.width = settingsBoundsRef.current.width + 'px';
                panel.style.height = settingsBoundsRef.current.height + 'px';
                panel.style.transform = 'none';
            }
            setSettingsMaximized(false);
        }
        settingsSyncResizeLayer();
        syncSettingsResizeLayerPos();
    }, [settingsMaximized, settingsSyncResizeLayer, syncSettingsResizeLayerPos]);

    const handleSettingsToggleMin = useCallback(() => {
        const panel = settingsPanelRef.current;
        if (!panel) return;
        setSettingsMinimized(prev => !prev);
        settingsSyncResizeLayer();
        syncSettingsResizeLayerPos();
    }, [settingsSyncResizeLayer, syncSettingsResizeLayerPos]);

    // 全局鼠标监听（拖动/拉伸）
    useEffect(() => {
        if (!showSettingsPanel) return;
        const move = (e) => handleSettingsMouseMove(e);
        const up = () => handleSettingsMouseUp();
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        // 面板打开后同步拉伸层定位（等面板渲染完成）
        const raf = requestAnimationFrame(syncSettingsResizeLayerPos);
        return () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            cancelAnimationFrame(raf);
        };
    }, [showSettingsPanel, handleSettingsMouseMove, handleSettingsMouseUp, syncSettingsResizeLayerPos]);

    // ─── 统计面板：拖动 / 拉伸 ───
    const syncStatsResizeLayerPos = useCallback(() => {
        const panel = statsPanelRef.current;
        const layer = statsResizeLayerRef.current;
        if (!panel || !layer) return;
        const r = panel.getBoundingClientRect();
        layer.style.left = r.left + 'px';
        layer.style.top = r.top + 'px';
        layer.style.width = r.width + 'px';
        layer.style.height = r.height + 'px';
    }, []);

    const handleStatsHeaderMouseDown = useCallback((e) => {
        if (e.target.closest('.ext-float-btn')) return;
        const panel = statsPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        statsDragRef.current = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        e.preventDefault();
    }, []);

    const handleStatsMouseMove = useCallback((e) => {
        const panel = statsPanelRef.current;
        if (!panel) return;
        if (statsDragRef.current) {
            const d = statsDragRef.current;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            let newLeft = d.origLeft + dx;
            let newTop = d.origTop + dy;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 60));
            newLeft = Math.max(-panel.offsetWidth + 80, Math.min(newLeft, window.innerWidth - 80));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
            panel.style.transform = 'none';
            syncStatsResizeLayerPos();
        } else if (statsResizeRef.current) {
            const d = statsResizeRef.current;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            let newLeft = d.origLeft, newTop = d.origTop, newW = d.origW, newH = d.origH;
            const minW = 400, minH = 300;
            if (d.dir.indexOf('e') !== -1) newW = Math.max(minW, d.origW + dx);
            if (d.dir.indexOf('s') !== -1) newH = Math.max(minH, d.origH + dy);
            if (d.dir.indexOf('w') !== -1) { newW = Math.max(minW, d.origW - dx); newLeft = d.origLeft + (d.origW - newW); }
            if (d.dir.indexOf('n') !== -1) { newH = Math.max(minH, d.origH - dy); newTop = d.origTop + (d.origH - newH); }
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 40));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            panel.style.transform = 'none';
            syncStatsResizeLayerPos();
        }
    }, [syncStatsResizeLayerPos]);

    const handleStatsMouseUp = useCallback(() => {
        statsDragRef.current = null;
        statsResizeRef.current = null;
    }, []);

    const handleStatsResizeDown = useCallback((dir) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        const panel = statsPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        statsResizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, origW: rect.width, origH: rect.height };
    }, []);

    useEffect(() => {
        if (!showStatsPanel) return;
        const move = (e) => handleStatsMouseMove(e);
        const up = () => handleStatsMouseUp();
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        const raf = requestAnimationFrame(syncStatsResizeLayerPos);
        return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); cancelAnimationFrame(raf); };
    }, [showStatsPanel, handleStatsMouseMove, handleStatsMouseUp, syncStatsResizeLayerPos]);

    // ─── 数据分析面板：最小化 / 最大化 ───
    const handleStatsToggleMin = useCallback(() => setStatsMinimized(v => !v), []);
    const handleStatsToggleMax = useCallback(() => {
        const panel = statsPanelRef.current;
        if (!panel) return;
        if (!statsMaximized) {
            const rect = panel.getBoundingClientRect();
            statsSavedBounds.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            panel.style.top = ''; panel.style.left = ''; panel.style.right = '';
            panel.style.bottom = ''; panel.style.width = ''; panel.style.height = '';
            panel.style.transform = '';
            setStatsMaximized(true);
        } else {
            if (statsSavedBounds.current) {
                panel.style.top = statsSavedBounds.current.top + 'px';
                panel.style.left = statsSavedBounds.current.left + 'px';
                panel.style.right = 'auto'; panel.style.bottom = 'auto';
                panel.style.width = statsSavedBounds.current.width + 'px';
                panel.style.height = statsSavedBounds.current.height + 'px';
                panel.style.transform = 'none';
            }
            setStatsMaximized(false);
        }
    }, [statsMaximized]);

    // ─── 调试器悬浮框：拖动 / 拉伸 / 最大化 / 最小化 / 关闭 ───
    const syncDebuggerResizeLayerPos = useCallback(() => {
        const panel = debuggerPanelRef.current;
        const layer = debuggerResizeLayerRef.current;
        if (!panel || !layer) return;
        const r = panel.getBoundingClientRect();
        layer.style.left = r.left + 'px';
        layer.style.top = r.top + 'px';
        layer.style.width = r.width + 'px';
        layer.style.height = r.height + 'px';
    }, []);

    const handleDebuggerHeaderMouseDown = useCallback((e) => {
        if (debuggerMaximized) return;
        // 按钮 / 表单控件不触发拖拽，否则点按钮会顺手把面板拖走
        if (e.target.closest('.ext-float-btn')) return;
        if (e.target.closest('button, input, select, textarea, a, label')) return;
        const panel = debuggerPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        debuggerDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            origLeft: rect.left,
            origTop: rect.top,
            lockedWidth: panel.style.width || (panel.offsetWidth + 'px')
        };
        e.preventDefault();
    }, [debuggerMaximized]);

    const handleDebuggerMouseMove = useCallback((e) => {
        const panel = debuggerPanelRef.current;
        if (!panel) return;
        if (debuggerDragRef.current) {
            const d = debuggerDragRef.current;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            let newLeft = d.origLeft + dx;
            let newTop = d.origTop + dy;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 60));
            newLeft = Math.max(-panel.offsetWidth + 80, Math.min(newLeft, window.innerWidth - 80));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
            panel.style.width = d.lockedWidth || panel.style.width || (panel.offsetWidth + 'px');
            panel.style.transform = 'none';
            syncDebuggerResizeLayerPos();
        } else if (debuggerResizeRef.current) {
            const d = debuggerResizeRef.current;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            let newLeft = d.origLeft, newTop = d.origTop, newW = d.origW, newH = d.origH;
            const minW = 340, minH = 260;
            if (d.dir.indexOf('e') !== -1) newW = Math.max(minW, d.origW + dx);
            if (d.dir.indexOf('s') !== -1) newH = Math.max(minH, d.origH + dy);
            if (d.dir.indexOf('w') !== -1) { newW = Math.max(minW, d.origW - dx); newLeft = d.origLeft + (d.origW - newW); }
            if (d.dir.indexOf('n') !== -1) { newH = Math.max(minH, d.origH - dy); newTop = d.origTop + (d.origH - newH); }
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 40));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            panel.style.transform = 'none';
            syncDebuggerResizeLayerPos();
        }
    }, [syncDebuggerResizeLayerPos]);

    const handleDebuggerMouseUp = useCallback(() => {
        debuggerDragRef.current = null;
        debuggerResizeRef.current = null;
    }, []);

    const handleDebuggerResizeDown = useCallback((dir) => (e) => {
        if (debuggerMaximized) return;
        e.preventDefault();
        e.stopPropagation();
        const panel = debuggerPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        debuggerResizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, origW: rect.width, origH: rect.height };
    }, [debuggerMaximized]);

    useEffect(() => {
        if (!showDebuggerPanel) return;
        const move = (e) => handleDebuggerMouseMove(e);
        const up = () => handleDebuggerMouseUp();
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        const raf = requestAnimationFrame(syncDebuggerResizeLayerPos);
        return () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            cancelAnimationFrame(raf);
        };
    }, [showDebuggerPanel, handleDebuggerMouseMove, handleDebuggerMouseUp, syncDebuggerResizeLayerPos]);

    const handleDebuggerToggleMin = useCallback(() => setDebuggerMinimized(v => !v), []);

    const handleDebuggerToggleMax = useCallback(() => {
        const panel = debuggerPanelRef.current;
        if (!panel) return;
        if (!debuggerMaximized) {
            const rect = panel.getBoundingClientRect();
            debuggerSavedBounds.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            panel.style.top = ''; panel.style.left = ''; panel.style.right = '';
            panel.style.bottom = ''; panel.style.width = ''; panel.style.height = '';
            panel.style.transform = '';
            setDebuggerMaximized(true);
        } else {
            if (debuggerSavedBounds.current) {
                panel.style.top = debuggerSavedBounds.current.top + 'px';
                panel.style.left = debuggerSavedBounds.current.left + 'px';
                panel.style.right = 'auto'; panel.style.bottom = 'auto';
                panel.style.width = debuggerSavedBounds.current.width + 'px';
                panel.style.height = debuggerSavedBounds.current.height + 'px';
                panel.style.transform = 'none';
            }
            setDebuggerMaximized(false);
        }
        syncDebuggerResizeLayerPos();
    }, [debuggerMaximized, syncDebuggerResizeLayerPos]);

    /** 打开调试器悬浮框（已最小化则一并还原）。右侧代码面板常驻，不受影响。 */
    const handleOpenDebugger = useCallback(() => {
        setShowDebuggerPanel(true);
        setDebuggerMinimized(false);
    }, []);

    /** 关闭调试器悬浮框；右侧代码面板不受影响。 */
    const handleCloseDebugger = useCallback(() => {
        setShowDebuggerPanel(false);
        setDebuggerMinimized(false);
        setDebuggerMaximized(false);
    }, []);

    // ─── 用户面板悬浮框：拖动 / 拉伸 / 最大化 / 最小化 ───
    const userDragRef = useRef(null);
    const userResizeRef = useRef(null);

    const openUserPanel = useCallback((type) => {
        setUserPanelType(type);
        setUserMinimized(false);
        setUserMaximized(false);
        // 关闭其他用户面板状态
        setShowProfilePanel(false);
        setShowFriendsPanel(false);
        setShowSavesPanel(false);
    }, []);

    const closeUserPanel = useCallback(() => {
        setUserPanelType(null);
        setUserMinimized(false);
        setUserMaximized(false);
    }, []);

    const handleUserHeaderMouseDown = useCallback((e) => {
        if (userMaximized) return;
        if (e.target.closest('.ext-float-btn')) return;
        const panel = userFloatRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        userDragRef.current = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        e.preventDefault();
    }, [userMaximized]);

    const handleUserMouseMove = useCallback((e) => {
        const panel = userFloatRef.current;
        if (!panel) return;
        if (userDragRef.current) {
            const d = userDragRef.current;
            const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
            let newLeft = d.origLeft + dx, newTop = d.origTop + dy;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 60));
            newLeft = Math.max(-panel.offsetWidth + 80, Math.min(newLeft, window.innerWidth - 80));
            panel.style.left = newLeft + 'px'; panel.style.top = newTop + 'px';
            panel.style.right = 'auto'; panel.style.transform = 'none';
        } else if (userResizeRef.current) {
            const d = userResizeRef.current;
            const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
            let newLeft = d.origLeft, newTop = d.origTop, newW = d.origW, newH = d.origH;
            const minW = 420, minH = 360;
            if (d.dir.indexOf('e') !== -1) newW = Math.max(minW, d.origW + dx);
            if (d.dir.indexOf('s') !== -1) newH = Math.max(minH, d.origH + dy);
            if (d.dir.indexOf('w') !== -1) { newW = Math.max(minW, d.origW - dx); newLeft = d.origLeft + (d.origW - newW); }
            if (d.dir.indexOf('n') !== -1) { newH = Math.max(minH, d.origH - dy); newTop = d.origTop + (d.origH - newH); }
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 40));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
            panel.style.left = newLeft + 'px'; panel.style.top = newTop + 'px';
            panel.style.right = 'auto'; panel.style.width = newW + 'px'; panel.style.height = newH + 'px';
            panel.style.transform = 'none';
        }
    }, []);

    const handleUserMouseUp = useCallback(() => { userDragRef.current = null; userResizeRef.current = null; setUserResizeLayerOn(false); }, []);

    const handleUserResizeDown = useCallback((dir) => (e) => {
        if (userMaximized) return; e.preventDefault(); e.stopPropagation();
        const panel = userFloatRef.current; if (!panel) return;
        const rect = panel.getBoundingClientRect();
        userResizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, origW: rect.width, origH: rect.height };
        setUserResizeLayerOn(true);
    }, [userMaximized]);

    const handleUserToggleMax = useCallback(() => {
        const panel = userFloatRef.current; if (!panel) return;
        if (!userMaximized) {
            const rect = panel.getBoundingClientRect();
            userFloatSavedBounds.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            // Clear inline positioning so CSS .maximized class takes over
            panel.style.top = '';
            panel.style.left = '';
            panel.style.right = '';
            panel.style.bottom = '';
            panel.style.width = '';
            panel.style.height = '';
            panel.style.transform = '';
            setUserMaximized(true);
        } else {
            // Restore saved bounds as inline styles
            if (userFloatSavedBounds.current) {
                panel.style.top = userFloatSavedBounds.current.top + 'px';
                panel.style.left = userFloatSavedBounds.current.left + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.width = userFloatSavedBounds.current.width + 'px';
                panel.style.height = userFloatSavedBounds.current.height + 'px';
                panel.style.transform = 'none';
            }
            setUserMaximized(false);
        }
    }, [userMaximized]);

    const handleUserToggleMin = useCallback(() => { setUserMinimized(v => !v); }, []);

    // 用户面板全局鼠标监听
    useEffect(() => {
        if (!userPanelType) return;
        const move = (e) => handleUserMouseMove(e);
        const up = () => handleUserMouseUp();
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    }, [userPanelType, handleUserMouseMove, handleUserMouseUp]);

    // 打开设置面板并直接切到插件标签页（供原插件按钮入口复用）
    const handleOpenAddonsInSettings = useCallback(() => {
        setShowSettingsPanel(true);
        setSettingsTab('addons');
    }, []);

    // ---- Block preview: render each block in a hidden workspace, capture SVG XML ----
    const [previewBlocks, setPreviewBlocks] = useState([]);
    const [panelPreviewSvg, setPanelPreviewSvg] = useState('');
    const previewHostRef = useRef(null);
    const previewWorkspaceRef = useRef(null);
    const panelPreviewRef = useRef(null);
    const panelWorkspaceRef = useRef(null);

    const handleOpenPreview = useCallback(() => {
        setShowBlockPreview(true);
    }, []);

    const handleClosePreview = useCallback(() => {
        setShowBlockPreview(false);
        setPreviewBlocks([]);
    }, []);

    // Render customBlock previews — each customBlock becomes a *finished*
    // scratch block (matching AstraEditor preview behaviour). The block
    // shows the user-supplied NAME followed by all the fields as inputs,
    // just like a normal Scratch command block would render.
    useEffect(() => {
        if (!showBlockPreview || !previewHostRef.current) return;
        const host = previewHostRef.current;
        if (!previewWorkspaceRef.current) {
            previewWorkspaceRef.current = Blockly.inject(host, {
                renderer: 'scratch',
                toolbox: '<xml></xml>',
                media: blocklyMediaPath(),
                sounds: false,
                trashcan: false,
                scrollbars: false,
                zoom: {controls: false, wheel: false, startScale:1},
                grid: {spacing: 8, length: 1, colour: '#c9d9ee', snap: false},
                collapse: false
            });
        }
        const ws = previewWorkspaceRef.current;
        ws.getTopBlocks().forEach(b => b.dispose(false));

        const items = [];
        let yOffset = 8;
        customBlocks.forEach(function (cb, idx) {
            const svgXml = renderCustomBlockToSvg(ws, cb, idx, extInfo.color1);
            if (!svgXml) return;
            // Estimate height from svg width attr for stacking
            const m = svgXml.match(/height="(\d+)"/);
            const h = m ? Number(m[1]) : 40;
            items.push({
                type: cb.name || ('我的积木 ' + (idx + 1)),
                label: cb.name || ('我的积木 ' + (idx + 1)),
                svgXml: svgXml
            });
            yOffset += Math.max(20, h) + 4;
        });
        setPreviewBlocks(items);
    }, [showBlockPreview, customBlocks, extInfo.color1]);

    // Live preview of the currently-edited customBlock inside the builder
    // panel's "积木预览" zone. Re-renders whenever the active block or its
    // fields / blockType change — renders a REAL Scratch block SVG.
    useEffect(() => {
        // 面板关闭时清空，避免残留旧 SVG。
        if (!showBlockBuilder) {
            setPanelPreviewSvg('');
            if (panelWorkspaceRef.current) {
                try { panelWorkspaceRef.current.dispose(); } catch (e) { /* 忽略 */ }
                panelWorkspaceRef.current = null;
            }
            return;
        }
        const cb = customBlocks.find(b => b.id === currentBlockId);
        if (!cb || !panelPreviewRef.current) {
            setPanelPreviewSvg('');
            return;
        }
        const host = panelPreviewRef.current;

        // 关键：每次面板打开都重建 workspace。
        // 历史坑：宿主容器早期是 1×1（后已改为 1600×1200），一旦 Blockly 在
        // 错误尺寸下注入过，它的 svg 视口会被永久锁死成 0×0，之后即使调用
        // Blockly.svgResize 也救不回来（实测 viewBox 恒为 "0 0 0 0"）。
        // 与其修补脏实例，不如直接 dispose 重建，成本极低且行为确定。
        if (panelWorkspaceRef.current) {
            try { panelWorkspaceRef.current.dispose(); } catch (e) { /* 忽略 */ }
            panelWorkspaceRef.current = null;
        }
        // 清掉上一次注入可能残留的 svg 节点
        try {
            host.querySelectorAll('svg').forEach(s => s.remove());
        } catch (e) { /* 忽略 */ }

        try {
            panelWorkspaceRef.current = Blockly.inject(host, {
                renderer: 'scratch',
                toolbox: '<xml></xml>',
                media: blocklyMediaPath(),
                sounds: false,
                trashcan: false,
                scrollbars: false,
                zoom: {controls: false, wheel: false, startScale: 1},
                grid: {spacing: 8, length: 1, colour: '#c9d9ee', snap: false},
                collapse: false
            });
        } catch (e) {
            console.warn('[ExtBuilder] 面板预览 workspace 注入失败:', e);
            setPanelPreviewSvg('');
            return;
        }

        const ws = panelWorkspaceRef.current;
        // 离屏宿主不会自动触发 Blockly 重算视口，必须显式 resize。
        try { Blockly.svgResize(ws); } catch (e) { /* 忽略 */ }
        const idx = customBlocks.findIndex(b => b.id === currentBlockId);
        let svg = '';
        try {
            svg = renderCustomBlockToSvg(ws, cb, Math.max(0, idx), extInfo.color1);
        } finally {
            // 关键：拿到 SVG 字符串后立刻销毁预览 workspace 并清空宿主。
            // scratch-blocks 的 Blockly.inject 会往文档里插入固定 id 的全局
            // clipPath（blocklyBlockMenuClipPath / blocklyBlockMenuClipRect），
            // 它假设整页只有一个 workspace。主工作区与预览 workspace 共存时
            // 会产生重复 id，主工作区 flyout 的 clip-path 引用会被解析到预览
            // 那个（尺寸 248×1196 ≠ 280×812），导致左侧积木栏被裁切甚至消失。
            // 预览只需要这段 SVG 字符串，workspace 本身无须保留。
            try { ws.dispose(); } catch (e) { /* 忽略 */ }
            panelWorkspaceRef.current = null;
            try { while (host.firstChild) host.removeChild(host.firstChild); } catch (e) { /* 忽略 */ }
        }
        setPanelPreviewSvg(svg);
        // showBlockBuilder 必须进依赖：面板关闭时 panelPreviewRef.current 是
        // null，effect 提前 return 并「记住」了这次执行；面板打开后若依赖没变，
        // effect 不会重跑，预览就永远停在初始空态。
    }, [currentBlockId, customBlocks, extInfo.color1, showBlockBuilder]);

    const handleApplySettings = useCallback(() => {
        if (!settingsDraft) return;
        const trimmed = settingsDraft.name.trim() || DEFAULT_EXTENSION_INFO.name;
        const id = settingsDraft.customId
            ? (settingsDraft.id.trim() || DEFAULT_EXTENSION_INFO.id)
            : DEFAULT_EXTENSION_INFO.id;
        // TurboWarp / scratch-vm only accepts ids matching /^[a-z0-9]+$/i
        // (letters and digits only — no hyphens, underscores, or other
        // punctuation).
        const safeId = id.toLowerCase().replace(/[^a-z0-9]/g, '') || 'myextension';
        setExtInfo({...settingsDraft, name: trimmed, id: safeId});
        handleCloseSettings();
    }, [settingsDraft]);

    const handlePickColor = useCallback((preset) => {
        if (!settingsDraft) return;
        setSettingsDraft({
            ...settingsDraft,
            color1: preset[0],
            color2: preset[1],
            color3: preset[2]
        });
    }, [settingsDraft]);

    const handlePickIcon = useCallback((targetKey) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file || !settingsDraft) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                setSettingsDraft(d => d ? {...d, [targetKey]: ev.target.result} : d);
            };
            reader.readAsDataURL(file);
        };
        input.click();
    }, [settingsDraft]);

    const handleClearIcon = useCallback((targetKey) => {
        if (!settingsDraft) return;
        setSettingsDraft(d => d ? {...d, [targetKey]: ''} : d);
    }, [settingsDraft]);

    const handleExport = useCallback(() => {
        console.log('Export clicked, code length:', generatedCode.length);
        try {
            const fullCode = wrapAsExtension(extInfo, generatedCode, customBlocks);
            const blob = new Blob([fullCode], {type: 'application/javascript'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${extInfo.id}.js`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('Export complete:', `${extInfo.id}.js`);
        } catch (e) {
            console.error('Export failed:', e);
            alert('导出失败: ' + e.message);
        }
    }, [extInfo, generatedCode, customBlocks]);

    // 复制完整代码到剪贴板（兼容非 HTTPS 环境：navigator.clipboard 不可用时
    // 回退到 execCommand）
    const handleCopyCode = useCallback(() => {
        const text = exportableCode || generatedCode;
        if (!text) return;
        const flashCopy = () => {
            setCopyMsg('已复制');
            if (copyMsgTimerRef.current) clearTimeout(copyMsgTimerRef.current);
            copyMsgTimerRef.current = setTimeout(() => setCopyMsg(''), 1800);
        };
        const fallbackCopy = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                flashCopy();
            } catch (err) {
                alert('复制失败，请手动选中代码复制（Ctrl+C）');
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(flashCopy).catch(fallbackCopy);
        } else {
            fallbackCopy();
        }
    }, [exportableCode, generatedCode]);

    const handleReset = useCallback(() => {
        try {
            if (workspaceRef.current) {
                workspaceRef.current.clear();
                const currentBlock = customBlocks.find(b => b.id === currentBlockRef.current);
                addStarterBlocks(
                    workspaceRef.current,
                    window._extBuilderBlockly || window.Blockly,
                    currentBlock?.name || '我的积木',
                    currentBlock?.id,
                    currentBlock?.blockType || 'command',
                    currentBlock?.colour || ''
                );
            }
        } catch (e) {
            console.error('Reset failed:', e);
            alert('重置失败: ' + e.message);
        }
    }, [customBlocks]);

    // 插件开关：保存状态 → 重新激活插件（清理旧的原型覆写再应用新的）
    const handleToggleAddon = useCallback((addonId, enabled) => {
        setAddonStateInternal(prev => {
            const next = {...prev, [addonId]: enabled};
            setAddonState(next);
            return next;
        });
        // 重新应用插件：先清理，再按新状态激活
        // 注意：Blockly 是 useEffect 内的局部变量，这里用全局 window 引用
        const Blockly = window._extBuilderBlockly || window.Blockly;
        if (!Blockly || !workspaceRef.current) return;
        if (extAddonsCleanupRef.current) {
            try { extAddonsCleanupRef.current(); } catch (e) { /* silent */ }
            extAddonsCleanupRef.current = null;
        }
        applyExtAddons({
            Blockly,
            getWorkspace: () => workspaceRef.current
        }).then(cleanup => {
            extAddonsCleanupRef.current = cleanup;
        }).catch(e => console.warn('[ExtAddons] 重激活失败:', e));
    }, []);

    // 插件子选项切换（如 developer-tools 的增强整理/鼠标粘贴）
    const handleToggleAddonOption = useCallback((addonId, optId, value) => {
        setAddonOptsInternal(prev => {
            const addonPrev = prev[addonId] || {};
            const next = {...prev, [addonId]: {...addonPrev, [optId]: value}};
            setAddonOptions(addonId, next[addonId]);
            return next;
        });
        // 子选项变更后不需要重新 applyExtAddons——
        // developer-tools 的 setup 内部通过 optsPoller 轮询 localStorage 自动响应
    }, []);

    // ExtAddons：导出设置（JSON 下载）
    const handleAddonExport = useCallback(() => {
        try {
            const blob = new Blob([JSON.stringify(addonState, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'extbuilder-addons-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('导出失败: ' + (e.message || String(e)));
        }
    }, [addonState]);

    // ExtAddons：导入设置（读取 JSON 文件，校验 ID 后合并）
    const handleAddonImport = useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    if (typeof data !== 'object' || data === null) throw new Error('文件格式错误');
                    const validIds = new Set(getAllAddons().map(a => a.id));
                    const merged = {...addonState};
                    let changed = 0;
                    Object.keys(data).forEach(k => {
                        if (validIds.has(k)) {
                            merged[k] = !!data[k];
                            changed++;
                        }
                    });
                    if (changed === 0) throw new Error('文件中没有可识别的插件 ID');
                    setAddonState(merged);
                    setAddonStateInternal(merged);
                    // 重激活
                    const Blockly = window._extBuilderBlockly || window.Blockly;
                    if (Blockly && workspaceRef.current) {
                        if (extAddonsCleanupRef.current) {
                            try { extAddonsCleanupRef.current(); } catch (er) { /* silent */ }
                            extAddonsCleanupRef.current = null;
                        }
                        applyExtAddons({Blockly, getWorkspace: () => workspaceRef.current})
                            .then(cleanup => { extAddonsCleanupRef.current = cleanup; });
                    }
                    alert('已导入 ' + changed + ' 项插件设置');
                } catch (err) {
                    alert('导入失败: ' + (err.message || String(err)));
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }, [addonState]);

    // ExtAddons：全部重置为默认（清空 localStorage 强制下次读 DEFAULT_STATE）
    const handleAddonReset = useCallback(() => {
        if (!confirm('确定重置全部插件设置到默认值？')) return;
        try { localStorage.removeItem('extbuilder_ext_addons'); } catch (e) { /* silent */ }
        const fresh = getAddonState();
        setAddonStateInternal(fresh);
        const Blockly = window._extBuilderBlockly || window.Blockly;
        if (Blockly && workspaceRef.current) {
            if (extAddonsCleanupRef.current) {
                try { extAddonsCleanupRef.current(); } catch (er) { /* silent */ }
                extAddonsCleanupRef.current = null;
            }
            applyExtAddons({Blockly, getWorkspace: () => workspaceRef.current})
                .then(cleanup => { extAddonsCleanupRef.current = cleanup; });
        }
    }, []);

    // ExtAddons：删除一个自定义插件（按 id）
    const handleRemoveCustomAddon = useCallback((id) => {
        if (!confirm('确定删除自定义插件「' + id + '」？此操作不可撤销。')) return;
        try {
            removeCustomAddon(id);
            // 若当前已启用，先禁用并清理
            if (addonState[id]) {
                const nextState = {...addonState};
                delete nextState[id];
                setAddonState(nextState);
                setAddonStateInternal(nextState);
                const Blockly = window._extBuilderBlockly || window.Blockly;
                if (Blockly && workspaceRef.current) {
                    if (extAddonsCleanupRef.current) {
                        try { extAddonsCleanupRef.current(); } catch (er) { /* silent */ }
                        extAddonsCleanupRef.current = null;
                    }
                    applyExtAddons({Blockly, getWorkspace: () => workspaceRef.current})
                        .then(cleanup => { extAddonsCleanupRef.current = cleanup; });
                }
            }
        } catch (e) {
            console.error('Remove custom addon failed:', e);
        }
    }, [addonState]);

    // 重新激活所有插件（导入/更新/删除后调用）
    // 注意：必须定义在下面 handleRemoveDirPlugin 之前 —— 后者把它写进了
    // useCallback 的依赖数组，而依赖数组是在渲染时立即求值的。
    // 若把 reapplyAddons 放在后面，求值时会踩到 const 的暂时性死区（TDZ），
    // 直接抛 ReferenceError 让整个面板白屏。
    const reapplyAddons = useCallback(() => {
        const Blockly = window._extBuilderBlockly || window.Blockly;
        if (!Blockly || !workspaceRef.current) return;
        if (extAddonsCleanupRef.current) {
            try { extAddonsCleanupRef.current(); } catch (er) { /* silent */ }
            extAddonsCleanupRef.current = null;
        }
        applyExtAddons({Blockly, getWorkspace: () => workspaceRef.current})
            .then(cleanup => { extAddonsCleanupRef.current = cleanup; });
    }, []);

    /**
     * ExtAddons：删除「编辑器数据文件夹」里安装的插件（按目录名）。
     *
     * 和上面的自定义插件删除是两条不同的路：
     *   - custom：插件源码存在 localStorage 里，前端自己删；
     *   - dirPlugin：插件是磁盘上的一个目录，只能请后端删。
     *
     * 内置（随编辑器分发）的插件在界面上就不给按钮，后端还会再拒一次 ——
     * 因为删了也会被下次启动的 deployBundled() 铺回来，做这件事只会让人困惑。
     */
    const handleRemoveDirPlugin = useCallback(async (addon) => {
        const dirName = addon.dirName || addon.id;
        const label = addon.name || dirName;
        if (!confirm('确定删除插件「' + label + '」？\n\n会连同它的目录一起删掉，此操作不可撤销。')) return;
        try {
            const out = await removeDirPlugin(dirName);
            if (!out.ok) {
                if (out.error === 'builtin') {
                    alert(out.message || '这是随编辑器分发的内置插件，不能删除。');
                } else {
                    alert('删除失败：' + (out.message || out.error || '未知错误'));
                }
                return;
            }
            // 已启用的话先停用，避免它的 setup 残留（比如改过的原型、挂上的监听）。
            const nextState = {...addonState};
            if (nextState[addon.id]) {
                delete nextState[addon.id];
                setAddonState(nextState);
                setAddonStateInternal(nextState);
            }
            // 重新拉一次清单：_dirPlugins 是模块级数组，得让它和后端磁盘对齐，
            // 再用 addonListVersion 触发重渲染，否则删掉的那行会留在列表里。
            await loadDirPlugins().catch(() => []);
            setAddonListVersion(v => v + 1);
            reapplyAddons();
        } catch (e) {
            alert('删除失败：' + (e && e.message ? e.message : String(e)));
        }
    }, [addonState, reapplyAddons]);

    // 安装面板拖动
    const handleInstallDragStart = useCallback((e) => {
        if (e.target.closest('.ext-float-btns')) return;
        const panel = installPanelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        const move = (ev) => {
            panel.style.left = (ev.clientX - startX) + 'px';
            panel.style.top = (ev.clientY - startY) + 'px';
            panel.style.right = 'auto';
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            const r = panel.getBoundingClientRect();
            setInstallFloatBounds({ x: r.left, y: r.top, w: r.width, h: r.height });
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        bringToFront('install');
    }, [bringToFront]);

    // 从来源安装插件（对齐 DSH：dsh plugin add <npm/github/git/url>）
    const handleInstallFromSource = useCallback(async (sourceSpec) => {
        if (!sourceSpec || !sourceSpec.trim()) { setInstallLog(prev => [...prev, {type: 'error', text: '✕ 请输入来源（npm 包名 / github:owner/repo / 直链 URL）'}]); return; }
        setInstallLoading(true);
        setInstallLog(prev => [...prev, {type: 'info', text: '⏳ 正在解析来源：' + sourceSpec.trim()}]);
        try {
            const imported = await importAddonFromSource(sourceSpec.trim());
            if (!imported.length) throw new Error('来源中没有有效的插件对象');
            const nextState = {...addonState};
            imported.forEach(p => { nextState[p.id] = true; });
            setAddonState(nextState);
            setAddonStateInternal(nextState);
            reapplyAddons();
            setInstallLog(prev => [...prev, {type: 'success', text: '✓ 已安装 ' + imported.length + ' 个插件：' + imported.map(p => p.name).join('、')}]);
            setInstallLoading(false);
        } catch (err) {
            setInstallLoading(false);
            setInstallLog(prev => [...prev, {type: 'error', text: '✕ 安装失败：' + (err && err.message ? err.message : String(err))}]);
        }
    }, [addonState, reapplyAddons]);

    // 通用：导入成功后激活
    const _activateImported = useCallback((imported, label) => {
        const nextState = {...addonState};
        imported.forEach(p => { nextState[p.id] = true; });
        setAddonState(nextState);
        setAddonStateInternal(nextState);
        reapplyAddons();
        setInstallLog(prev => [...prev, {type: 'success', text: '✓ 已安装 ' + imported.length + ' 个插件：' + imported.map(p => p.name).join('、')}]);
        setInstallLoading(false);
    }, [addonState, reapplyAddons]);

    // 选择本地文件安装（支持：单个 JS / 文件夹 / ZIP 三种模式）
    // mode: 'file' 单 JS | 'folder' 文件夹(webkitdirectory) | 'zip' ZIP 包
    const handleInstallLocalFile = useCallback((mode) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (mode === 'folder') {
            input.webkitdirectory = true;
            input.setAttribute('webkitdirectory', '');
            input.mozdirectory = true;
            input.setAttribute('mozdirectory', '');
        } else if (mode === 'zip') {
            input.accept = '.zip,application/zip,application/x-zip-compressed';
        } else {
            input.accept = '.js,.mjs,text/javascript';
        }
        input.onchange = async (e) => {
            const fileList = e.target.files;
            if (!fileList || !fileList.length) return;
            setInstallLoading(true);
            setInstallError('');
            try {
                if (mode === 'folder') {
                    setInstallLog(prev => [...prev, {type: 'cmd', text: '$ import-folder ' + fileList.length + ' files'}]);
                    setInstallLog(prev => [...prev, {type: 'info', text: '⏳ 正在读取文件夹（' + fileList.length + ' 个文件）...'}]);
                    const imported = await importAddonBundle([...fileList], 'local:folder:' + (fileList[0].webkitRelativePath || fileList[0].name));
                    if (!imported.length) throw new Error('文件夹中没有有效的插件包');
                    _activateImported(imported, 'folder');
                } else if (mode === 'zip') {
                    const file = fileList[0];
                    setInstallLog(prev => [...prev, {type: 'cmd', text: '$ import-zip ' + file.name}]);
                    setInstallLog(prev => [...prev, {type: 'info', text: '⏳ 正在解压 ZIP...'}]);
                    const buf = await file.arrayBuffer();
                    const imported = await importAddonFromZip(buf, 'local:zip:' + file.name);
                    if (!imported.length) throw new Error('ZIP 中没有有效的插件包');
                    _activateImported(imported, 'zip');
                } else {
                    const file = fileList[0];
                    setInstallLog(prev => [...prev, {type: 'cmd', text: '$ import-file ' + file.name}]);
                    const reader = new FileReader();
                    reader.onload = () => {
                        setInstallLog(prev => [...prev, {type: 'info', text: '⏳ 正在安装本地文件...'}]);
                        importAddonFromSource('local:' + file.name, {fileText: String(reader.result)})
                            .then(imported => {
                                if (!imported.length) throw new Error('文件中没有有效的插件对象');
                                _activateImported(imported, 'file');
                            })
                            .catch(err => {
                                setInstallLoading(false);
                                setInstallLog(prev => [...prev, {type: 'error', text: '✕ 安装失败：' + (err && err.message ? err.message : String(err))}]);
                            });
                    };
                    reader.onerror = () => { setInstallLoading(false); setInstallLog(prev => [...prev, {type: 'error', text: '✕ 读取文件失败'}]); };
                    reader.readAsText(file);
                }
            } catch (err) {
                setInstallLoading(false);
                setInstallLog(prev => [...prev, {type: 'error', text: '✕ 安装失败：' + (err && err.message ? err.message : String(err))}]);
            }
        };
        input.click();
    }, [_activateImported]);

    // 按来源更新已安装插件
    const handleUpdateAddon = useCallback(async (id) => {
        try {
            await updateCustomAddonSource(id);
            reapplyAddons();
            alert('已更新插件：' + id);
        } catch (e) {
            alert('更新失败：' + (e && e.message ? e.message : String(e)));
        }
    }, [reapplyAddons]);

    // 打开/刷新插件市场（从 GitHub 主题聚合页加载所有带该 topic 的仓库插件）
    const handleOpenMarket = useCallback(async () => {
        setMarketView(true);
        setMarketError('');
        setMarketList([]); // 先清空旧数据，避免拉取失败时显示过期内容
        if (marketLoading) return; // 防止重复并发请求
        setMarketLoading(true);
        try {
            const list = await fetchAddonMarketFromTopic(MARKET_TOPIC);
            console.log('[ExtAddons] 市场返回', list.length, '个插件:', list.map(p => p.dir));
            if (!list.length) {
                // 仓库通了但清单是空的。这和「拉取失败」是两回事：
                // 前者要去补 plugins.json，后者要查网络 / CDN。分开提示。
                setMarketError('市场清单是空的：仓库能访问，但 plugins.json 里没有插件条目。');
                return;
            }
            setMarketList(list);
            // 标记已安装。两条来源都要看：
            //   - 浏览器侧插件：存在 localStorage 里，按 source 匹配；
            //   - 带 Node 服务的插件：是磁盘上的目录，按**目录名**匹配。
            // 只看前者的话，装好的 deepseek-web-panel 在市场里仍显示「安装」，
            // 用户点第二次才会发现没必要。
            const installed = {};
            const customSources = loadCustomAddons().map(a => (a.source || '').replace(/\/$/, ''));
            const dirNames = getDirPlugins().map(a => a.dirName || a.id);
            list.forEach(p => {
                if (p.hasServer) {
                    if (dirNames.indexOf(p.dir) >= 0) installed[p.dir] = true;
                    return;
                }
                if (customSources.indexOf(p.source.replace(/\/$/, '')) >= 0) installed[p.dir] = true;
            });
            setMarketInstalled(installed);
        } catch (e) {
            setMarketError('加载市场失败：' + (e && e.message ? e.message : String(e)));
        } finally {
            setMarketLoading(false);
        }
    }, [marketLoading]);

    /**
     * 从市场安装单个插件。
     *
     * 市场里有两种插件，安装路径完全不同，靠 item.hasServer 分流：
     *   - 浏览器侧插件：拉一个 index.js，eval 成插件对象存进 localStorage；
     *   - 带 Node 服务的插件（hasServer）：整个目录拉到
     *     %APPDATA%/scratch-extension-editor/plugins/，再由 Node 侧 fork 成
     *     子进程。这类插件没法只靠浏览器侧代码工作，必须落盘。
     * 走错路径的表现是「装完提示成功，但功能没出现」，很难从现象反推，
     * 所以这里显式分流而不是让后端去猜。
     */
    const handleMarketInstall = useCallback(async (item) => {
        setMarketInstalling(item.dir);
        try {
            const m = /^github:([^/]+)\/([^/]+)\/(.+)$/.exec(item.source || '');
            if (!m) throw new Error('插件来源格式不正确：' + (item.source || ''));
            // 仓库内子目录与安装目录名不是一回事，见 fetchAddonMarketFromTopic 的说明。
            const subdir = item.subdir === undefined || item.subdir === null ? m[3] : item.subdir;
            if (item.hasServer) {
                await installDirPluginFromGithub(m[1], m[2], subdir, item.dir);
                // 磁盘上多了一个目录，但页面侧的 _dirPlugins 还是旧快照。
                // 不重扫的话列表里看不到它，用户会以为没装上。
                await loadDirPlugins().catch(() => []);
                setAddonListVersion(v => v + 1);
                const nextState = {...addonState};
                nextState[item.dir] = true;
                setAddonState(nextState);
                setAddonStateInternal(nextState);
                reapplyAddons();
                setMarketInstalled(prev => ({...prev, [item.dir]: true}));
                alert('已安装插件：' + item.name + '\n\n它的 Node 服务已启动。若界面没立刻出现，重开一次编辑器即可。');
                return;
            }
            const imported = await importAddonFromGithubDir(m[1], m[2], m[3]);
            // 安装后默认启用（与 _activateImported 一致）
            const nextState = {...addonState};
            (imported || []).forEach(p => { nextState[p.id] = true; });
            setAddonState(nextState);
            setAddonStateInternal(nextState);
            reapplyAddons();
            setMarketInstalled(prev => ({...prev, [item.dir]: true}));
            alert('已安装插件：' + item.name);
        } catch (e) {
            alert('安装失败：' + (e && e.message ? e.message : String(e)));
        } finally {
            setMarketInstalling('');
        }
    }, [addonState, reapplyAddons]);

    const handleLoadExtension = useCallback(() => {
        console.log('Load clicked');
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.js';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    alert('已加载文件: ' + file.name);
                };
                reader.readAsText(file);
            };
            input.click();
        } catch (e) {
            console.error('Load failed:', e);
        }
    }, []);

    const handleUndo = useCallback(() => {
        console.log('Undo clicked, workspace:', !!workspaceRef.current);
        try {
            if (workspaceRef.current) {
                workspaceRef.current.undo(false);
            }
        } catch (e) {
            console.error('Undo failed:', e);
        }
    }, []);

    const handleRedo = useCallback(() => {
        console.log('Redo clicked, workspace:', !!workspaceRef.current);
        try {
            if (workspaceRef.current) {
                workspaceRef.current.undo(true);
            }
        } catch (e) {
            console.error('Redo failed:', e);
        }
    }, []);

    // 快捷键：Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+Z 撤销 / Ctrl+Y 重做（对齐 Bilup；放 handlers 定义之后避免 TDZ）
    // 以及界面快捷键：Ctrl+, 设置 / Ctrl+Shift+B 制作积木 / Ctrl+Shift+D 调试器
    //              / Ctrl+Shift+P 预览 / Ctrl+Shift+C 复制代码 / Ctrl+Shift+E 插件市场
    // 完整清单见设置面板「快捷键」标签页（与这里必须同步改）。
    useEffect(() => {
        const onKey = (e) => {
            const k = (e.key || '').toLowerCase();
            const editable = (() => {
                const t = e.target;
                return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
            })();
            const inBlockly = (() => {
                const t = e.target;
                return t && t.closest && t.closest('.blocklySvg, .blocklyTreeRoot, .blocklyFlyout');
            })();

            // ── Ctrl+Shift 系列：界面功能 ──
            if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                // 输入框里不抢 Shift 组合键（用户可能在输入大写/符号）
                if (editable || inBlockly) return;
                if (k === 'b') { e.preventDefault(); setShowEditMenu(false); setShowBlockBuilder(true); setBuilderMinimized(false); setBuilderMaximized(false); setBuilderModalPos(null); setBuilderSize(null); return; }
                if (k === 'd') { e.preventDefault(); setShowEditMenu(false); handleOpenDebugger(); return; }
                if (k === 'p') { e.preventDefault(); setShowFileMenu(false); handleOpenPreview(); return; }
                if (k === 'c') { e.preventDefault(); handleCopyCode(); return; }
                if (k === 'e') { e.preventDefault(); setShowSettingsPanel(true); setSettingsTab('addons'); setMarketView(true); return; }
                return;
            }

            // ── Ctrl+, 打开设置（无 Shift，避免与 Ctrl+Shift 系列冲突）──
            if ((e.ctrlKey || e.metaKey) && k === ',') {
                e.preventDefault();
                handleOpenSettings();
                return;
            }

            // ── Esc 关闭设置面板（优先级高于面板内其他 Esc 行为）──
            if (e.key === 'Escape' && showSettingsPanel && !settingsMinimized) {
                // 焦点在输入框里时 Esc 先让浏览器退出输入态，再按一次才关面板
                if (!editable) { e.preventDefault(); handleCloseSettings(); }
                return;
            }

            if (!(e.ctrlKey || e.metaKey)) return;
            if (k === 'o') { e.preventDefault(); handleLoadExtension(); return; }
            if (k === 's') { e.preventDefault(); handleExport(); return; }
            if (k === 'z' || k === 'y') {
                // 输入框交给浏览器原生撤销、Blockly 工作区交给 Blockly 自己的快捷键
                if (editable || inBlockly) return;
                e.preventDefault();
                if (k === 'z') handleUndo(); else handleRedo();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [handleLoadExtension, handleExport, handleUndo, handleRedo, handleOpenSettings, handleCloseSettings, handleOpenDebugger, handleOpenPreview, handleCopyCode, showSettingsPanel, settingsMinimized]);

    // ---- 登录 / 存档 / 跨站同步 handlers ----

    const refreshSaves = useCallback(() => {
        if (!session) {
            setSavesList([]);
            return;
        }
        // 先本地，再尝试云端拉取合并（多设备一致）
        setSavesList(listSaves(session.username));
        import('../lib/saves.js').then(m => {
            return m.syncSavesFromCloud(session.username);
        }).then(merged => {
            if (merged) setSavesList(merged);
        }).catch(() => { /* 云端不可用则保持本地 */ });
    }, [session]);

    // 打开存档面板时刷新列表
    const handleOpenSavesPanel = useCallback(() => {
        setSaveMsg('');
        setSyncLinkText('');
        setSyncInput('');
        refreshSaves();
        openUserPanel('saves');
    }, [refreshSaves, openUserPanel]);

    // 打开个人主页：加载账号资料 + 刷新存档列表 + 拉取关注/粉丝数
    const handleOpenProfile = useCallback(() => {
        if (!session) return;
        const username = session.username;
        setProfileMeta(getUserMeta(username));
        setProfileCounts({following: 0, followers: 0});
        refreshSaves();
        openUserPanel('profile');
        // 云端可用时拉取关注关系，统计关注数 / 粉丝数（本地模式为 0）
        cloudListRelations(username).then((rows) => {
            if (!Array.isArray(rows)) return;
            let following = 0;
            let followers = 0;
            for (const r of rows) {
                if (r.follower === username) following += 1;
                if (r.followee === username) followers += 1;
            }
            setProfileCounts({following, followers});
        }).catch(() => {
            // 拉取不影响主页其余内容，保持 0
        });
    }, [session, refreshSaves, openUserPanel]);

    // ---- 好友 / 关注 ----
    // 拉取我与他人的全部关注关系，并重算好友（互关）/ 我关注的 / 关注我的
    const loadFriendsRelations = useCallback(() => {
        if (!session) return Promise.resolve([]);
        return cloudListRelations(session.username).then((rows) => {
            setFriendsRelations(rows || []);
            return rows || [];
        }).catch((e) => {
            setFriendsMsg('加载好友关系失败：' + (e && e.message ? e.message : String(e)));
            return [];
        });
    }, [session]);

    const handleOpenFriends = useCallback(() => {
        setFriendsMsg('');
        setFriendsResults([]);
        setFriendsSearch('');
        setFriendsTab('friends');
        openUserPanel('friends');
        loadFriendsRelations();
    }, [loadFriendsRelations, openUserPanel]);

    const handleFriendSearch = useCallback(() => {
        if (!session) return;
        const q = friendsSearch.trim();
        if (!q) { setFriendsResults([]); return; }
        setFriendsBusy(true);
        setFriendsMsg('');
        cloudSearchUsers(q, session.username).then((list) => {
            setFriendsResults(list || []);
            if (!list || list.length === 0) setFriendsMsg('没有找到匹配的用户');
        }).catch((e) => {
            setFriendsMsg('搜索失败：' + (e && e.message ? e.message : String(e)));
        }).then(() => setFriendsBusy(false));
    }, [friendsSearch, session]);

    // direction: 'follow' 关注对方；'unfollow-following' 取消关注（我→对方）；
    // 'unfollow-follower' 移除粉丝（对方→我）；'unfriend' 解除好友（取消我对对方的关注）
    const handleFriendAction = useCallback((target, action) => {
        if (!session) return;
        const me = session.username;
        setFriendsBusy(true);
        setFriendsMsg('');
        let p;
        if (action === 'follow') {
            p = cloudFollow(me, target);
        } else if (action === 'unfollow-following' || action === 'unfriend') {
            p = cloudUnfollow(me, target);
        } else if (action === 'unfollow-follower') {
            p = cloudUnfollow(target, me);
        } else {
            p = Promise.resolve();
        }
        p.then(() => loadFriendsRelations())
            .catch((e) => {
                setFriendsMsg('操作失败：' + (e && e.message ? e.message : String(e)));
            })
            .then(() => setFriendsBusy(false));
    }, [session, loadFriendsRelations]);

    // 停止 Device Flow 轮询（关闭弹窗 / 换账号 / 卸载时调用）
    const stopDeviceFlow = useCallback(() => {
        if (deviceFlowTimerRef.current) {
            clearTimeout(deviceFlowTimerRef.current);
            deviceFlowTimerRef.current = null;
        }
        deviceFlowBusyRef.current = false;
        setDeviceFlow(null);
    }, []);

    // 用 GitHub 登录：GitHub Device Flow。
    // 流程：向 GitHub 申请「用户码」→ 显示给用户并打开 github.com/login/device
    // → 用户在自己的 GitHub 里确认 → 本页按 interval 轮询换 access_token
    // → 拿 token 直连 api.github.com 取资料 → 建立本地会话。
    //
    // 相比原先的 authorize 重定向流程，这里没有 redirect_uri，因此：
    //   1. 不需要 scratchextensioneditor.cc.cd 上的换 token 服务端；
    //   2. 本地 127.0.0.1 也能登录（重定向流程在本地会被弹到线上编辑器）；
    //   3. 不经过任何第三方中转站点。
    // 代价：多一步「复制用户码」，且需在 GitHub OAuth App 里勾选 Enable Device Flow。
    const startDeviceFlow = useCallback(() => {
        if (typeof window === 'undefined') return;
        if (deviceFlowBusyRef.current) return; // 防重复点击
        deviceFlowBusyRef.current = true;
        setDeviceFlow({status: 'starting', userCode: '', verificationUri: '', error: ''});

        startGitHubDeviceFlow().then((d) => {
            if (!deviceFlowBusyRef.current) return; // 已被取消
            setDeviceFlow({
                status: 'waiting',
                userCode: d.userCode,
                verificationUri: d.verificationUriComplete || d.verificationUri,
                error: ''
            });
            // 打开 GitHub 的设备授权页；URL 里预填了 user_code，用户只需点确认。
            // 弹窗被拦截也不影响：用户码已显示在面板上，可手动打开并输入。
            try {
                window.open(d.verificationUriComplete || d.verificationUri, 'github-device', 'width=600,height=720');
            } catch (e) { /* 见上 */ }

            const deadline = Date.now() + d.expiresIn * 1000;
            let interval = d.interval;

            const tick = () => {
                if (!deviceFlowBusyRef.current) return;
                if (Date.now() > deadline) {
                    deviceFlowBusyRef.current = false;
                    setDeviceFlow((f) => Object.assign({}, f, {
                        status: 'error',
                        error: '设备码已过期，请关闭后重新点击登录'
                    }));
                    return;
                }
                pollGitHubDeviceToken(d.deviceCode).then((r) => {
                    if (!deviceFlowBusyRef.current) return;
                    // 成功：拿 token 取资料并建立会话
                    if (r && r.access_token) {
                        return fetchGitHubProfile(r.access_token)
                            .then((profile) => loginWithGitHub(profile, true))
                            .then((s) => {
                                setSession(s);
                                setUserPanelType(null);
                                deviceFlowBusyRef.current = false;
                                setDeviceFlow(null);
                            });
                    }
                    // 用户还没确认：继续等
                    if (r && r.error === 'authorization_pending') {
                        deviceFlowTimerRef.current = setTimeout(tick, interval * 1000);
                        return undefined;
                    }
                    // 轮询过快：按 GitHub 要求拉长间隔
                    if (r && r.error === 'slow_down') {
                        interval += 5;
                        deviceFlowTimerRef.current = setTimeout(tick, interval * 1000);
                        return undefined;
                    }
                    // 其余都是终止性错误（access_denied / expired_token / …）
                    deviceFlowBusyRef.current = false;
                    setDeviceFlow((f) => Object.assign({}, f, {
                        status: 'error',
                        error: (r && (r.error_description || r.error)) || '授权失败，请重试'
                    }));
                    return undefined;
                }).catch((err) => {
                    if (!deviceFlowBusyRef.current) return;
                    deviceFlowBusyRef.current = false;
                    setDeviceFlow((f) => Object.assign({}, f, {
                        status: 'error',
                        error: err && err.message ? err.message : String(err)
                    }));
                });
                return undefined;
            };

            deviceFlowTimerRef.current = setTimeout(tick, interval * 1000);
        }).catch((err) => {
            deviceFlowBusyRef.current = false;
            setDeviceFlow({
                status: 'error',
                userCode: '',
                verificationUri: '',
                error: err && err.message ? err.message : String(err)
            });
        });
    }, []);

    // 点「GitHub 登录」：先过用户条款，再启动 Device Flow。
    // 未同意时先把意图记下并弹条款窗，用户点「同意并继续」后自动接着走 Device Flow，
    // 不需要他再点一次登录。
    const handleGitHubLogin = useCallback(() => {
        if (!legalAgreed) {
            pendingLoginRef.current = true;
            setLegalModal('terms');
            return;
        }
        // 线上主入口是 PAT 粘贴登录（理由见 patLogin 注释）；
        // Device Flow 降级为弹窗内的「本地开发模式」折叠项，手动展开才走。
        setPatLogin({busy: false, error: '', showForm: true});
    }, [legalAgreed]);

    /**
     * PAT 粘贴登录（线上主登录方式，理由见 patLogin state 注释）。
     * 成功后：session 建立 + token 存 sessionStorage（关浏览器即失效，
     * 不落 localStorage —— 与现有「不长期保存 token」的安全取向一致）；
     * 若探测到 gist 权限，社区发布直接可用，无需再走一次授权。
     */
    const handlePatLogin = useCallback(async () => {
        if (!legalAgreed) {
            pendingLoginRef.current = true;
            setLegalModal('terms');
            return;
        }
        const pat = patInputRef.current ? patInputRef.current.value.trim() : '';
        setPatLogin({busy: true, error: '', showForm: true});
        try {
            const {session: s, token, hasGistScope} = await loginWithPAT(pat, true);
            // 只有带 gist 权限的 token 才存给社区发布用 —— 否则发布时会
            // 拿着一个没权限的 token 去调 Gist API，报错让人摸不着头脑
            if (hasGistScope) {
                try { sessionStorage.setItem('forgeext_gist_token', token); } catch (e) { /* 无痕 */ }
            }
            setSession(s);
            setUserPanelType(null);
            setPatLogin({busy: false, error: '', showForm: false});
            if (!hasGistScope) {
                // token 能登录但不能发社区 —— 提示一句，不打断登录
                alert('已登录 GitHub。注意：这个 Token 没有 gist 权限，发布社区扩展时会提示重新授权。');
            }
        } catch (e) {
            setPatLogin({busy: false, error: (e && e.message) || String(e), showForm: true});
        }
    }, [legalAgreed]);

    // 卸载时停掉轮询，避免组件销毁后 setState
    useEffect(() => () => {
        if (deviceFlowTimerRef.current) clearTimeout(deviceFlowTimerRef.current);
        deviceFlowBusyRef.current = false;
    }, []);

    const handleLogout = useCallback(() => {
        // 切换账号前保存当前会话（支持一键切回）
        if (session) savePrevSession(session);
        authLogout();
        stopDeviceFlow(); // 若授权流程还在轮询，一并取消
        setSession(null);
        setUserPanelType(null);
        setPrevSession(getPrevSession());
    }, [session, stopDeviceFlow]);

    // 切换账号：记住当前 → 退出 → 直接走 GitHub 授权
    const handleSwitchAccount = useCallback(() => {
        if (session) savePrevSession(session);
        authLogout();
        // 必须先停掉上一轮授权：deviceFlowBusyRef 为 true 时 handleGitHubLogin
        // 会直接 return，否则「切换账号」会静默失效。
        stopDeviceFlow();
        setSession(null);
        setUserPanelType(null);
        setPrevSession(getPrevSession());
        handleGitHubLogin();
    }, [session, handleGitHubLogin, stopDeviceFlow]);

    // 一键切回到上一个账号
    const handleSwitchBack = useCallback(() => {
        const restored = switchToPrevSession();
        if (restored) {
            setSession(restored);
            setPrevSession(null); // 已切回，清除 prev
            setUserPanelType(null);
        }
    }, []);

    // 多账号切换：切换到指定账号
    const handleSwitchToAccount = useCallback((username) => {
        if (!username || (session && username === session.username)) return;
        const newSession = switchToAccount(username);
        if (newSession) {
            setSession(newSession);
            setAccountList(getRegisteredAccounts()); // 刷新列表（虽然内容不变，保持一致）
            setShowUserMenu(false);
            setShowAccountSwitcher(false);
        }
    }, [session]);

    // 接收来自 scratchextensioneditor.cc.cd 网站的登录会话（跨域：网站登录后 postMessage 给编辑器）
    // 处理两种消息类型：
    //   - site-session：网站首页/旧路径推送
    //   - site-session-response：登录页 goHome() 通过 window.opener 直接推送 / session-bridge.html 桥接推送
    useEffect(() => {
        function onSiteSession(e) {
            if (!e.data) return;
            if (e.data.type !== 'site-session' && e.data.type !== 'site-session-response') return;
            const ALLOWED = [
                'https://scratchextensioneditor.cc.cd',
                'https://scratchextensioneditor.pages.dev'
            ];
            // site-session-response 可能来自登录页（window.opener.postMessage），origin 就是网站 origin
            // 也可能来自任何来源的 bridge iframe（sandbox 后 origin 变为网站 origin）
            if (ALLOWED.indexOf(e.origin) === -1) return;
            const payload = e.data;
            if (!payload.session || !payload.session.username) return;
            try {
                const s = payload.session;
                ensureSiteAccount(s.username); // 确保本地账号存在，刷新后 getSession 才能通过账号校验
                localStorage.setItem('extbuilder_session', JSON.stringify(s));
                setSession(s);
                setUserPanelType(null);
            } catch (err) {
                console.warn('[Editor] 接收网站会话失败:', err);
            }
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('message', onSiteSession);
        }
        return () => {
            if (typeof window !== 'undefined') {
                window.removeEventListener('message', onSiteSession);
            }
        };
    }, []);

    // 兜底通道：回调页在 opener 不可用（浏览器 COOP / 弹窗拦截）时，
    // 会把会话编码进 URL 的 #gh= 里跳回本编辑器页面，这里读出来并登录。
    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            const hash = window.location.hash || '';
            if (!/(^|[#&])gh=/.test(hash)) return;
            const params = new URLSearchParams(hash.replace(/^#/, ''));
            const raw = params.get('gh');
            if (!raw) return;
            const s = JSON.parse(decodeURIComponent(raw));
            if (!s || !s.username) return;
            ensureSiteAccount(s.username); // 保证本地账号存在，刷新后 getSession 才能通过校验
            localStorage.setItem('extbuilder_session', JSON.stringify(s));
            setSession(s);
            setUserPanelType(null);
            setShowAuthModal(false);
            // 立即清掉地址栏里的凭据，避免残留在历史/分享链接中
            params.delete('gh');
            const rest = params.toString();
            window.history.replaceState(
                null, '',
                window.location.pathname + window.location.search + (rest ? '#' + rest : '')
            );
        } catch (err) {
            console.warn('[Editor] 解析 URL 登录回传失败:', err);
        }
    }, []);

    // 同源其他标签页写入会话时自动同步（storage 事件只在「其他」标签页触发，本页不触发）
    useEffect(() => {
        if (typeof window === 'undefined') return;
        function onStorage(e) {
            if (e.key !== 'extbuilder_session') return;
            try {
                const s = e.newValue ? JSON.parse(e.newValue) : null;
                if (s && s.username) {
                    ensureSiteAccount(s.username);
                    setSession(s);
                } else {
                    setSession(null);
                }
            } catch (err) { /* 忽略解析错误 */ }
        }
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    // 启动时通过隐藏 iframe 尝试拉取 scratchextensioneditor.cc.cd 的登录会话
    // session-bridge.html 加载后主动 postMessage 回 session 数据，由上面的 onSiteSession 接收
    useEffect(() => {
        if (typeof window === 'undefined' || session) return; // 已有本地会话则不拉
        var bridgeUrls = [
            'https://scratchextensioneditor.cc.cd/session-bridge.html',
            'https://scratchextensioneditor.pages.dev/session-bridge.html'
        ];
        var iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:none;';
        iframe.sandbox = 'allow-scripts allow-same-origin';
        var idx = 0;
        function tryNext() {
            if (idx >= bridgeUrls.length) {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                return;
            }
            iframe.src = bridgeUrls[idx++];
        }
        function onBridgeResponse(e) {
            if (!e.data || e.data.type !== 'site-session-response') return;
            if (e.data.session && e.data.session.username) {
                var s = e.data.session;
                try {
                    localStorage.setItem('extbuilder_session', JSON.stringify(s));
                    setSession(s);
                    setUserPanelType(null);
                } catch (err) { /* ignore */ }
            }
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            window.removeEventListener('message', onBridgeResponse);
        }
        window.addEventListener('message', onBridgeResponse);
        iframe.onload = function () { };
        document.body.appendChild(iframe);
        tryNext();
        setTimeout(function () {
            window.removeEventListener('message', onBridgeResponse);
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 8000);
        return () => {
            window.removeEventListener('message', onBridgeResponse);
            if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        };
    }, [session]);

    // 用户从网站登录页切回编辑器时，自动重新拉取网站会话（隐藏 iframe 桥接）
    // 健壮性：单个域名 5s 无响应自动换备用域；同时监听 focus；未登录且标签页可见时重试若干次，
    // 避免"一次性超时/网络抖动"导致同步不上（早前只试一次且 8s 才清理）。
    useEffect(() => {
        if (typeof window === 'undefined' || session) return;
        var pulling = false;
        var attempts = 0;

        function pullSiteSession() {
            if (pulling || getSession()) return;
            if (attempts >= 15) return; // 约 90 秒后放弃，避免无限轮询
            attempts += 1;
            pulling = true;
            var bridgeUrls = [
                'https://scratchextensioneditor.cc.cd/session-bridge.html',
                'https://scratchextensioneditor.pages.dev/session-bridge.html'
            ];
            var idx = 0;
            var timer = null;
            var iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:none;';
            iframe.sandbox = 'allow-scripts allow-same-origin';

            function cleanup() {
                pulling = false;
                if (timer) { clearTimeout(timer); timer = null; }
                window.removeEventListener('message', onBridgeResponse);
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }
            function tryNext() {
                if (idx >= bridgeUrls.length) { cleanup(); return; }
                iframe.src = bridgeUrls[idx++];
                // 5 秒没回音就换下一个域名
                timer = setTimeout(tryNext, 5000);
            }
            function onBridgeResponse(e) {
                if (!e.data || e.data.type !== 'site-session-response') return;
                if (e.data.session && e.data.session.username) {
                    var s = e.data.session;
                    try {
                        ensureSiteAccount(s.username); // 确保本地账号存在，刷新后 getSession 才能通过账号校验
                        localStorage.setItem('extbuilder_session', JSON.stringify(s));
                        setSession(s);
                        setUserPanelType(null);
                    } catch (err) { /* ignore */ }
                }
                cleanup();
            }
            window.addEventListener('message', onBridgeResponse);
            document.body.appendChild(iframe);
            tryNext();
        }

        function onVisible() {
            if (document.visibilityState === 'visible') pullSiteSession();
        }
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        // 切回来后若桥接还没返回（网络慢），补几次轮询
        var poll = setInterval(pullSiteSession, 6000);
        return () => {
            clearInterval(poll);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);
        };
    }, [session]);

    // 清除本地账号数据：清空本浏览器 localStorage / sessionStorage 中的账号注册表与会话
    // （与线上账号清零配套的本地收口；云端残留账号需另行处理）
    const handleClearLocalData = useCallback(() => {
        if (typeof window !== 'undefined' && window.confirm) {
            const ok = window.confirm(
                '确定要清除本地的所有账号数据吗？\n\n' +
                '将删除：本地账号注册表、当前登录会话、切换账号记录。\n' +
                '此操作不可恢复，但不会删除你在服务器上的账号。'
            );
            if (!ok) return;
        }
        clearLocalAuthData();
        setSession(null);
        setPrevSession(null);
        setShowUserMenu(false);
        setUserPanelType(null);
    }, []);

    // 保存当前项目为新存档
    const handleSaveProject = useCallback(() => {
        if (!session) return;
        try {
            saveCurrentWorkspace();
            const data = collectProjectState({
                extInfo,
                customBlocks,
                workspaceXmlMap: customBlockXmlRef.current,
                generatedCode
            });
            const name = saveNameInput.trim() || ('存档 ' + new Date().toLocaleString());
            saveProject(session.username, {id: 'save_' + Date.now(), name, data});
            setSaveNameInput('');
            refreshSaves();
            setSaveMsg('已保存存档：' + name);
        } catch (err) {
            setSaveMsg('保存失败：' + (err.message || err));
        }
    }, [session, extInfo, customBlocks, generatedCode, saveNameInput,
        refreshSaves, saveCurrentWorkspace]);

    // 文件菜单：一键创建存档（对齐 Bilup 的「创建还原点」，无需打开存档面板）
    const handleQuickSave = useCallback(() => {
        setShowFileMenu(false);
        if (!session) {
            // 未登录：直接走 GitHub 授权（不再跳网站登录页）
            handleGitHubLogin();
            return;
        }
        try {
            saveCurrentWorkspace();
            const data = collectProjectState({
                extInfo,
                customBlocks,
                workspaceXmlMap: customBlockXmlRef.current,
                generatedCode
            });
            const name = '存档 ' + new Date().toLocaleString();
            saveProject(session.username, {id: 'save_' + Date.now(), name, data});
            refreshSaves();
            alert('已创建存档：' + name);
        } catch (err) {
            alert('保存失败：' + (err.message || err));
        }
    }, [session, extInfo, customBlocks, generatedCode, refreshSaves, saveCurrentWorkspace, handleGitHubLogin]);

    // 用当前项目覆盖已有存档
    const handleOverwriteSave = useCallback((saveId) => {
        if (!session) return;
        try {
            saveCurrentWorkspace();
            const data = collectProjectState({
                extInfo,
                customBlocks,
                workspaceXmlMap: customBlockXmlRef.current,
                generatedCode
            });
            const old = savesList.find(s => s.id === saveId);
            saveProject(session.username, {id: saveId, name: (old && old.name) || '存档', data});
            refreshSaves();
            setSaveMsg('已更新存档：' + ((old && old.name) || ''));
        } catch (err) {
            setSaveMsg('更新失败：' + (err.message || err));
        }
    }, [session, extInfo, customBlocks, generatedCode, savesList,
        refreshSaves, saveCurrentWorkspace]);

    const handleDeleteSave = useCallback((saveId) => {
        if (!session) return;
        const target = savesList.find(s => s.id === saveId);
        if (!target) return;
        if (!window.confirm('确定删除存档「' + target.name + '」吗？此操作不可恢复。')) return;
        deleteSave(session.username, saveId);
        refreshSaves();
        setSaveMsg('已删除存档：' + target.name);
    }, [session, savesList, refreshSaves]);

    // 恢复 block_define 上的生成元数据（opcode/type/text）
    const rehydrateBlockMeta = useCallback((ws, blocks) => {
        const tops = ws.getTopBlocks ? ws.getTopBlocks(true) : [];
        tops.forEach(t => {
            if (t.type !== 'block_define') return;
            const svg = t.getSvgRoot && t.getSvgRoot();
            const bid = svg && svg.getAttribute('data-block-id');
            const cb = blocks.find(b => b.id === bid);
            if (!cb) return;
            t._opcode = (cb.id || 'block').replace(/[^a-zA-Z0-9]/g, '_');
            const bt = String(cb.blockType || 'command').toUpperCase();
            t._type = bt === 'BOOLEAN' ? 'BOOLEAN'
                : bt === 'REPORTER' ? 'REPORTER'
                    : bt === 'HAT' ? 'HAT'
                        : bt === 'CONDITIONAL' ? 'CONDITIONAL' : 'COMMAND';
            t._text = '[' + (cb.name || 'block') + ']';
            // 同步积木颜色：自定义色 > 扩展主题色（getInfo().color1）。
            // 这里必须用 resolveBlockColour —— 早期版本写死 `cb.colour || 290`，
            // 导致用户一改任何属性就把工作区积木刷回紫色，与预览/导出不一致。
            if (t.setColour) {
                try {
                    t.setColour(resolveBlockColour(cb, extColor1Ref.current));
                } catch (e) { /* 忽略非法色 */ }
            }
            // 定义块禁止删除（覆盖从 XML 存档恢复的块）
            if (t.setDeletable) t.setDeletable(false);
        });
    }, []);

    // 任何 customBlocks 变化（创建/编辑/删除/导入）都同步到 Blockly 工作区
    // 并刷新生成代码面板——否则用户在"积木定义"面板改了 name/type 等信息，
    // 工作区里既有的 block_define 块对应的 _opcode/_type/_text 不会更新，
    // 代码面板仍显示旧内容。
    useEffect(() => {
        const ws = workspaceRef.current;
        if (!ws || !workspaceLoaded) return;
        rehydrateBlockMeta(ws, customBlocks);
        try {
            setGeneratedCode(javascriptGenerator.workspaceToCode(ws));
        } catch (e) { /* silent */ }
        // 依赖里必须含 extInfo.color1：用户在设置里换主题色后，
        // 工作区积木要立即跟着换色（预览走自己的 effect，导出走 useMemo）。
    }, [customBlocks, workspaceLoaded, extInfo.color1]);

    // 用存档中的积木列表 + 工作区 XML 重建当前 Blockly 工作区
    const rebuildWorkspaceFromState = useCallback((blocks, xmlMap) => {
        const ws = workspaceRef.current;
        const B = window._extBuilderBlockly || window.Blockly;
        if (!ws || !B) return;
        try {
            ws.clear();
            const firstId = blocks.length ? blocks[0].id : null;
            currentBlockRef.current = firstId;
            setCurrentBlockId(firstId);
            const xml = firstId ? xmlMap.get(firstId) : null;
            if (xml) {
                try {
                    const dom = B.Xml.textToDom(xml);
                    B.Xml.domToWorkspace(dom, ws);
                } catch (e) {
                    console.warn('Restore XML failed, adding starter blocks instead:', e);
                    blocks.forEach(b => addStarterBlocks(ws, B, b.name, b.id, b.blockType, b.colour));
                }
            } else {
                blocks.forEach(b => addStarterBlocks(ws, B, b.name, b.id, b.blockType, b.colour));
            }
            rehydrateBlockMeta(ws, blocks);
            try {
                setGeneratedCode(javascriptGenerator.workspaceToCode(ws));
            } catch (e) { /* silent */ }
        } catch (e) {
            console.warn('rebuildWorkspaceFromState failed:', e);
        }
    }, [rehydrateBlockMeta]);

    /**
     * 把项目快照灌进当前工作区。存档加载、社区导入、导入文件都走这里 ——
     * 三条路径的差别只是「快照从哪来」，还原动作完全一样，合成一处才不会
     * 各自漏掉某个 state（比如积木定义换了但扩展名没换）。
     */
    const applyProjectSnapshot = useCallback((data) => {
        const restored = restoreProjectState(data);
        setExtInfo({...DEFAULT_EXTENSION_INFO, ...restored.extInfo});
        setCustomBlocks(restored.customBlocks);
        customBlockXmlRef.current = restored.workspaceXmlMap;
        setGeneratedCode(restored.generatedCode);
        rebuildWorkspaceFromState(restored.customBlocks, restored.workspaceXmlMap);
    }, [rebuildWorkspaceFromState]);

    // 加载一个存档（恢复全部项目状态）
    const handleLoadSave = useCallback((save) => {
        if (!save || !save.data) return;
        try {
            applyProjectSnapshot(save.data);
            setUserPanelType(null);
            setSaveMsg('已加载存档：' + save.name);
            alert('已加载存档：' + save.name);
        } catch (err) {
            alert('加载存档失败：' + (err.message || err));
        }
    }, [applyProjectSnapshot]);

    // 收集当前项目快照（社区发布用；与存档同一份数据）
    const collectSnapshot = useCallback(() => collectProjectState({
        extInfo,
        customBlocks,
        workspaceXmlMap: customBlockXmlRef.current,
        generatedCode
    }), [extInfo, customBlocks, generatedCode]);

    // 社区「以此为基础修改」的还原入口：换 ID 避免与原作者冲突
    const restoreFromCommunity = useCallback((data) => {
        applyProjectSnapshot(data);
        setUserPanelType(null);
    }, [applyProjectSnapshot]);

    /**
     * 消费社区页传来的导入载荷。
     * 社区页把快照放进 sessionStorage 后跳过来（不用 URL 传：快照有几十万
     * 字符，拼进 URL 会超长还会进浏览器历史），这里读完立刻清掉，避免
     * 用户刷新一次就被重复导入。
     *
     * 键名：品牌 2026-10 从 ExtForge 改成 ForgeExt，这里也换成新键；但
     * 旧键里可能还留着跳转中断时的载荷（用户改名后没走完流程），所以
     * 新旧两个键都读一遍，先读到即清。localStorage/sessionStorage 的键
     * 名不是协议的一部分（只有社区页与编辑器需要一致），换掉是安全的。
     */
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const KEYS = ['forgeext_import', 'extforge_import'];
        let raw = null;
        try {
            for (const k of KEYS) {
                const v = window.sessionStorage.getItem(k);
                if (v) { raw = v; window.sessionStorage.removeItem(k); break; }
            }
        } catch (e) { return; }
        if (!raw) return;
        let entry = null;
        try { entry = parseCommunityEntry(raw); } catch (e) { /* ignore */ }
        if (!entry) return;
        applyProjectSnapshot({
            extInfo: entry.extInfo,
            customBlocks: entry.customBlocks,
            workspaceXml: entry.workspaceXml,
            generatedCode: entry.generatedCode
        });
        setSaveMsg('已从社区载入扩展，可直接编辑');
    }, [applyProjectSnapshot]);

    // 从 JSON 文件导入存档（登录后存入当前账号）
    const handleImportSaveFile = useCallback(() => {
        if (!session) {
            alert('请先登录后再导入存档');
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const save = parseSaveFileText(String(ev.target.result));
                    saveProject(session.username, {
                        id: save.id || ('save_' + Date.now()),
                        name: save.name || file.name.replace(/\.json$/i, ''),
                        data: save.data
                    });
                    refreshSaves();
                    setSaveMsg('已导入存档：' + (save.name || file.name));
                } catch (err) {
                    alert('导入失败：' + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }, [session, refreshSaves]);

    // 生成同步链接（在另一个部署打开即可互通）
    const handleGenSync = useCallback(() => {
        if (!session) return;
        try {
            const url = buildSyncUrl(session.username);
            setSyncLinkText(url);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url)
                    .then(() => setSaveMsg('同步链接已生成并复制到剪贴板'))
                    .catch(() => setSaveMsg('同步链接已生成（复制失败，可手动选择复制）'));
            } else {
                setSaveMsg('同步链接已生成（请手动复制）');
            }
        } catch (err) {
            setSaveMsg('生成失败：' + (err.message || err));
        }
    }, [session]);

    // 粘贴对方网站的同步链接并导入
    const handleImportSync = useCallback(() => {
        const payload = parseSyncPayload(syncInput);
        if (!payload) {
            setSaveMsg('链接无效，请检查后重试');
            return;
        }
        const ok = window.confirm(
            '检测到来自「' + (payload.site || '其他站点') + '」的同步数据。\n' +
            '账号：' + payload.user.username + '\n' +
            '存档数量：' + (payload.saves ? payload.saves.length : 0) + '\n\n' +
            '导入后本网站的登录账号与存档将与对方互通（已存在的存档不会被覆盖），是否继续？'
        );
        if (!ok) return;
        try {
            const res = importSyncPayload(payload);
            setSession(getSession());
            setSavesList(listSaves(payload.user.username));
            setSyncInput('');
            const msg = res.created
                ? '已在本站创建账号「' + res.username + '」并登录，互通成功。'
                : '账号「' + res.username + '」已存在，已合并其存档，互通成功。';
            setSaveMsg(msg + (res.merged ? ' 新增存档 ' + res.merged + ' 个。' : ''));
        } catch (err) {
            setSaveMsg('同步失败：' + (err.message || err));
        }
    }, [syncInput]);

    // 页面加载时检测 URL 中的 #sync= 同步链接并提示导入
    useEffect(() => {
        if (typeof location === 'undefined' || !location.hash) return;
        if (location.hash.indexOf('#sync=') !== 0) return;
        const payload = parseSyncPayload(location.hash);
        if (!payload) return;
        const ok = window.confirm(
            '检测到来自「' + (payload.site || '其他站点') + '」的同步链接。\n' +
            '账号：' + payload.user.username + '\n' +
            '存档数量：' + (payload.saves ? payload.saves.length : 0) + '\n\n' +
            '导入后本网站的登录账号与存档将与对方互通，是否继续？'
        );
        try {
            if (ok) {
                const res = importSyncPayload(payload);
                setSession(getSession());
                const msg = res.created
                    ? '已在本站创建账号「' + res.username + '」并登录，互通成功。'
                    : '账号「' + res.username + '」已存在，已合并其存档，互通成功。';
                alert(msg + (res.merged ? ' 新增存档 ' + res.merged + ' 个。' : ''));
            }
        } catch (err) {
            alert('同步失败：' + (err.message || err));
        }
        // 清除 hash，避免刷新页面重复提示
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch (e) { /* ignore */ }
    }, []);

    // Add a block by type - removed (use Blockly drag-from-flyout instead)

    // Always render the UI - Blockly loads in background
    return (
        <div className="ext-builder">
            {/* Top menu bar (mimics TurboWarp's red top bar) */}
            <div className="ext-menu-bar">
                                <div className="ext-menu-bar-left">
                    <div className="ext-menu-brand">
                        <span className="ext-menu-logo">⊞</span>
                        <span className="ext-menu-title">扩展编辑器</span>
                    </div>
                    {/* 文件下拉菜单（对齐 Bilup：新建/打开/保存/存档） */}
                    <div className="ext-tools-dropdown" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setShowFileMenu(false); }}>
                        <button
                            className="ext-menu-btn"
                            onClick={() => setShowFileMenu(v => !v)}
                            title="文件"
                        >
                            <svg className="ext-menu-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                            <span className="ext-menu-btn-label">文件</span>
                            <span className="ext-menu-arrow">▾</span>
                        </button>
                        {showFileMenu && (
                            <div className="ext-tools-menu">
                                <button className="ext-tools-menu-item" onClick={() => { setShowFileMenu(false); if (window.confirm('新建扩展？当前工作区将被清空（可在存档管理中恢复）。')) handleReset(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                                    新建
                                </button>
                                <button className="ext-tools-menu-item" onClick={() => { setShowFileMenu(false); handleLoadExtension(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                    从电脑中打开
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>Ctrl+O</span>
                                </button>
                                <button className="ext-tools-menu-item" onClick={() => { setShowFileMenu(false); handleExport(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                    保存到电脑
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>Ctrl+S</span>
                                </button>
                                <div className="ext-user-menu-divider"></div>
                                <button className="ext-tools-menu-item" onClick={handleQuickSave}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,9 15,9"/></svg>
                                    创建存档
                                </button>
                                <button className="ext-tools-menu-item" onClick={() => { setShowFileMenu(false); handleOpenSavesPanel(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15,14"/></svg>
                                    存档管理
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>还原点</span>
                                </button>
                                <div className="ext-user-menu-divider"></div>
                                <button className="ext-tools-menu-item" onClick={() => { setShowFileMenu(false); handleOpenPreview(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                    预览
                                </button>
                            </div>
                        )}
                    </div>
                    {/* 编辑下拉菜单（对齐 Bilup：恢复/撤销/重做 + 制作积木入口） */}
                    <div className="ext-tools-dropdown" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setShowEditMenu(false); }}>
                        <button
                            className="ext-menu-btn"
                            onClick={() => setShowEditMenu(v => !v)}
                            title="编辑"
                        >
                            <svg className="ext-menu-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                            <span className="ext-menu-btn-label">编辑</span>
                            <span className="ext-menu-arrow">▾</span>
                        </button>
                        {showEditMenu && (
                            <div className="ext-tools-menu">
                                <button className="ext-tools-menu-item" onClick={() => { setShowEditMenu(false); handleOpenSavesPanel(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
                                    恢复
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>存档</span>
                                </button>
                                <button className="ext-tools-menu-item" onClick={() => { setShowEditMenu(false); handleUndo(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H13"/></svg>
                                    撤销
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>Ctrl+Z</span>
                                </button>
                                <button className="ext-tools-menu-item" onClick={() => { setShowEditMenu(false); handleRedo(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><polyline points="17,1 21,5 17,9"/><path d="M3 11V9a4 4 0 014-4h14"/></svg>
                                    重做
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>Ctrl+Y</span>
                                </button>
                                <div className="ext-user-menu-divider"></div>
                                <button className="ext-tools-menu-item" onClick={() => { setShowEditMenu(false); setShowBlockBuilder(true); setBuilderMinimized(false); setBuilderMaximized(false); setBuilderModalPos(null); setBuilderSize(null); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
                                    制作积木
                                </button>
                                <button className="ext-tools-menu-item" onClick={() => { setShowEditMenu(false); handleOpenDebugger(); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/><circle cx="12" cy="12" r="3"/></svg>
                                    调试器
                                    <span style={{marginLeft:'auto',fontSize:11,color:'#9aa0a6'}}>在线测试</span>
                                </button>
                            </div>
                        )}
                    </div>
                    <button className="ext-menu-btn" onClick={handleOpenSettings} title="扩展设置与插件管理">
                        <svg className="ext-menu-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                        <span className="ext-menu-btn-label">设置</span>
                    </button>
                    {/* 工具下拉菜单 */}
                    <div className="ext-tools-dropdown" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setShowToolsMenu(false); }}>
                        <button
                            className="ext-menu-btn ext-menu-tools-btn"
                            onClick={() => setShowToolsMenu(v => !v)}
                            title="工具"
                        >
                            <svg className="ext-menu-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
                            <span className="ext-menu-btn-label">工具</span>
                            <span className="ext-menu-arrow">▾</span>
                        </button>
                        {showToolsMenu && (
                            <div className="ext-tools-menu">
                                <button className="ext-tools-menu-item" onClick={() => { setShowToolsMenu(false); window.dispatchEvent(new CustomEvent('ext-toggle-realtime-collab')); }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                                    实时协作
                                </button>
                            </div>
                        )}
                    </div>
                    {!session ? (
                        <React.Fragment>
                            <button
                                className="ext-menu-btn"
                                onClick={handleGitHubLogin}
                                title="使用 GitHub 账号登录"
                            >
                                <span className="ext-menu-btn-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 015.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0023.5 12C23.5 5.73 18.27.5 12 .5z"/></svg></span>
                                <span className="ext-menu-btn-label">GitHub 登录</span>
                            </button>
                        </React.Fragment>
                    ) : (
                        <div className="ext-user-dropdown" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setShowUserMenu(false); }}>
                            <button
                                className="ext-menu-user"
                                onClick={() => setShowUserMenu(v => !v)}
                                title="用户菜单"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>{session.username} ▼</button>
                            {showUserMenu && (
                                <div className="ext-user-menu">
                                    <button className="ext-user-menu-item" onClick={() => { setShowUserMenu(false); window.open('https://scratchextensioneditor.cc.cd/users', '_blank'); }}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                        个人主页
                                    </button>
                                    <button className="ext-user-menu-item" onClick={() => { setShowUserMenu(false); handleOpenSavesPanel(); }}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,9 15,9"/></svg>
                                        存档管理
                                    </button>
                                    <button className="ext-user-menu-item" onClick={() => { setShowUserMenu(false); handleOpenFriends(); }}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                                        好友 / 关注
                                    </button>
                                    <div className="ext-user-menu-divider"></div>
                                    <button className="ext-user-menu-item ext-user-menu-danger" onClick={() => { setShowUserMenu(false); handleClearLocalData(); }}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d32f2f" strokeWidth="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                                        清除本地账号数据
                                    </button>
                                    <button className="ext-user-menu-item ext-user-menu-logout" onClick={() => { setShowUserMenu(false); handleLogout(); }}>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d32f2f" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                                        退出登录
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div className="ext-menu-bar-center">
                    <span className="ext-menu-ext-name">{extInfo.name}</span>
                    <span className="ext-menu-ext-id">({extInfo.id})</span>
                </div>
                <div className="ext-menu-bar-right">
                    {/* 加载 / 导出 / 重置三个按钮已从顶部移除（2026-10）：
                        它们在文件菜单里都有等价入口，顶栏只留扩展名与计数。
                        计数徽章单独钉在菜单栏右端、AI 按钮左侧 —— AI 按钮是
                        bilup-nova 的 bundle 异步注入的（.sa-nova），不是 React
                        子节点，所以徽章用 absolute 定位贴过去，而不是插到
                        React 树里 AI 按钮前面（插进别人管理的 DOM 会被挤掉）。 */}
                    <div className="ext-block-count-badge" onClick={() => setShowStatsPanel(v => !v)} title="点击查看项目数据分析">
                        <span className="ext-block-count-num">{projectStats.blockCount}</span>
                        <span className="ext-block-count-label">个积木</span>
                    </div>
                </div>
            </div>

            {/* Right side: main area */}
            <div className="ext-builder-right">
                {/* 标签栏已移除：「代码」与「调试器」两个入口现在分别在
                    右侧常驻代码面板与「编辑」下拉菜单里，不再需要顶部标签。 */}
                <div className="ext-builder-main">
                {/* Block builder as a floating window (opens via 制作积木 button) */}
                {showBlockBuilder && (
                    <div className="ext-builder-modal-backdrop" style={{zIndex: getZIndex('builder')}}>
                        <div
                            ref={builderModalRef}
                            className={`ext-builder-modal${builderMaximized ? ' maximized' : ''}`}
                            onMouseDown={() => bringToFront('builder')}
                            style={{
                                ...(builderModalPos ? { left: builderModalPos.x, top: builderModalPos.y, right: 'auto' } : null),
                                ...(builderSize ? { width: builderSize.width, height: builderSize.height } : null),
                                ...(builderMinimized ? { display: 'none' } : null),
                                zIndex: getZIndex('builder')
                            }}
                        >
                            <div
                                className="ext-builder-modal-header"
                                onMouseDown={handleBuilderDragStart}
                                title="拖动移动窗口"
                            >
                                <span className="ext-builder-modal-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="#5b21b6" stroke="#5b21b6" strokeWidth="1.5" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>制作积木</span>
                                <div className="ext-builder-modal-controls">
                                    <button
                                        type="button"
                                        className="ext-builder-tb-btn"
                                        onClick={handleBuilderMinimize}
                                        aria-label="最小化制作积木"
                                        title="最小化"
                                    >─</button>
                                    <button
                                        type="button"
                                        className="ext-builder-tb-btn"
                                        onClick={handleBuilderMaximize}
                                        aria-label={builderMaximized ? '还原制作积木' : '最大化制作积木'}
                                        title={builderMaximized ? '还原' : '最大化'}
                                    >{builderMaximized ? '❐' : '□'}</button>
                                    <button
                                        type="button"
                                        className="ext-builder-tb-btn"
                                        onClick={() => setShowBlockBuilder(false)}
                                        aria-label="关闭制作积木"
                                        title="关闭"
                                    >×</button>
                                </div>
                            </div>
                            {/* 8 方向拉伸手柄层（与实时协作一致） */}
                            {!builderMinimized && !builderMaximized && (
                                <div className="ext-builder-resize-layer">
                                    {BUILDER_RESIZE_DIRS.map((dir) => (
                                        <div
                                            key={dir}
                                            className={`ext-builder-rz-${dir}`}
                                            onMouseDown={(e) => handleBuilderResizeStart(e, dir)}
                                        />
                                    ))}
                                </div>
                            )}
                            <div className="ext-builder-modal-body">
                    <div className="ext-block-list">
                        <button
                            className="ext-block-list-settings"
                            onClick={handleOpenSettings}
                            title="扩展设置"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg> 扩展设置
                        </button>
                        <div className="ext-block-list-title">积木列表</div>
                        <div className="ext-block-list-items">
                            {customBlocks.map(block => (
                                <div
                                    key={block.id}
                                    className={`ext-block-list-item ${block.id === currentBlockId ? 'selected' : ''}`}
                                    onClick={() => editingBlockId !== block.id && handleSelectBlock(block.id)}
                                >
                                    {editingBlockId === block.id ? (
                                        <input
                                            className="ext-block-list-name-input"
                                            value={editingName}
                                            autoFocus
                                            onChange={(e) => setEditingName(e.target.value)}
                                            onClick={(e) => e.stopPropagation()}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    handleCommitRename(block.id);
                                                } else if (e.key === 'Escape') {
                                                    handleCancelRename();
                                                }
                                            }}
                                            onBlur={() => handleCommitRename(block.id)}
                                        />
                                    ) : (
                                        <span
                                            className="ext-block-list-name"
                                            onDoubleClick={(e) => {
                                                e.stopPropagation();
                                                handleStartRename(block.id, block.name);
                                            }}
                                            title="双击重命名"
                                        >{block.name}</span>
                                    )}
                                    {customBlocks.length > 1 && (
                                        <button
                                            className="ext-block-list-delete"
                                            onClick={(e) => { e.stopPropagation(); handleDeleteBlock(block.id); }}
                                            title="删除积木"
                                        ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                                    )}
                                </div>
                            ))}
                        </div>
                        <button className="ext-block-list-add" onClick={handleCreateBlock}>
                            + 创建积木
                        </button>

                        {/* Per-block editor (AstraEditor-style: type / config / target filter / icon) */}
                        {(() => {
                            const currentBlock = customBlocks.find(b => b.id === currentBlockId);
                            if (!currentBlock) return null;
                            return (
                                <div className="ext-block-editor">
                                    <div className="ext-block-editor-header">
                                        <span className="ext-block-editor-title">编辑积木</span>
                                        <span className="ext-block-editor-name">{currentBlock.name}</span>
                                    </div>

                                    {/* Live preview — shows the currently-edited block as a real Blockly SVG */}
                                    <div className="ext-block-editor-preview">
                                        <div className="ext-block-editor-preview-header">
                                            <span className="ext-block-editor-preview-label">
                                                {currentBlock.blockType === 'command' ? '命令积木'
                                                    : currentBlock.blockType === 'Boolean' ? '布尔积木'
                                                    : currentBlock.blockType === 'reporter' ? '报告积木'
                                                    : currentBlock.blockType === 'hat' ? '帽子积木'
                                                    : '条件积木'}
                                            </span>
                                        </div>
                                        <div
                                            className="ext-block-editor-preview-svg"
                                            dangerouslySetInnerHTML={{__html: panelPreviewSvg || '<span class="ext-block-editor-preview-empty">编辑字段以预览积木</span>'}}
                                        />
                                        <div
                                            ref={panelPreviewRef}
                                            className="ext-block-editor-preview-host"
                                            aria-hidden="true"
                                        />
                                    </div>

                                    {/* Field table (CB-ExtGallary style) */}
                                    <div className="ext-block-editor-fields-header">
                                        <span>类型</span>
                                        <span>文本</span>
                                        <span></span>
                                    </div>
                                    <div className="ext-block-editor-fields-list">
                                        {(Array.isArray(currentBlock.fields) ? currentBlock.fields : []).map((f, idx) => (
                                            <div key={idx} className="ext-block-editor-fields-row">
                                                <select
                                                    className="ext-block-editor-input ext-block-editor-input-type"
                                                    value={f.kind || 'text'}
                                                    onChange={(e) => handleUpdateField(currentBlock.id, idx, {kind: e.target.value})}
                                                >
                                                    <option value="label">标签</option>
                                                    <option value="text">字符串</option>
                                                    <option value="number">数字</option>
                                                    <option value="boolean">布尔</option>
                                                </select>
                                                <input
                                                    className="ext-block-editor-input ext-block-editor-input-text"
                                                    value={f.text || ''}
                                                    onChange={(e) => handleUpdateField(currentBlock.id, idx, {text: e.target.value})}
                                                    placeholder="字段文本"
                                                />
                                                {f.kind === 'number' && (
                                                    <input
                                                        className="ext-block-editor-input ext-block-editor-input-default"
                                                        type="number"
                                                        value={f.default || '0'}
                                                        onChange={(e) => handleUpdateField(currentBlock.id, idx, {default: e.target.value})}
                                                        placeholder="默认值"
                                                        title="数字默认值"
                                                    />
                                                )}
                                                {f.kind === 'boolean' && (
                                                    <select
                                                        className="ext-block-editor-input ext-block-editor-input-default"
                                                        value={f.default || 'true'}
                                                        onChange={(e) => handleUpdateField(currentBlock.id, idx, {default: e.target.value})}
                                                        title="布尔默认值"
                                                    >
                                                        <option value="true">是</option>
                                                        <option value="false">否</option>
                                                    </select>
                                                )}
                                                <button
                                                    type="button"
                                                    className="ext-block-editor-fields-delete"
                                                    onClick={() => handleRemoveField(currentBlock.id, idx)}
                                                    title="删除此字段"
                                                >删除</button>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Add field row (CB-ExtGallary style) */}
                                    <div className="ext-block-editor-fields-add">
                                        <button
                                            type="button"
                                            className="ext-block-editor-fields-add-btn"
                                            onClick={() => handleAddField(currentBlock.id, 'text')}
                                        >添加字段</button>
                                        <select
                                            className="ext-block-editor-input ext-block-editor-fields-add-type"
                                            defaultValue="text"
                                            id="ext-block-editor-fields-add-type-select"
                                        >
                                            <option value="label">标签</option>
                                            <option value="text">字符串</option>
                                            <option value="number">数字</option>
                                            <option value="boolean">布尔</option>
                                        </select>
                                    </div>

                                    {/* Block metadata (collapsed by default for cleaner UI) */}
                                    <div className="ext-block-editor-meta">
                                        <label className="ext-block-editor-label">ID</label>
                                        <input
                                            className="ext-block-editor-input"
                                            value={currentBlock.id.replace(/^block_/, '')}
                                            readOnly
                                            title="积木 ID 由系统生成，可在扩展设置中自定义扩展 ID"
                                        />

                                        <label className="ext-block-editor-label">积木类型</label>
                                        <select
                                            className="ext-block-editor-input"
                                            value={currentBlock.blockType || 'command'}
                                            onChange={(e) => handleUpdateBlock(currentBlock.id, {blockType: e.target.value})}
                                        >
                                            <option value="command">命令积木</option>
                                            <option value="Boolean">布尔积木</option>
                                            <option value="reporter">报告积木</option>
                                            <option value="hat">帽子积木</option>
                                            <option value="conditional">条件积木</option>
                                        </select>

                                        <label className="ext-block-editor-label">积木颜色</label>
                                        <div className="ext-block-colour-picker">
                                            <input
                                                type="color"
                                                className="ext-block-colour-input"
                                                value={resolveBlockColour(currentBlock, extInfo.color1)}
                                                onChange={(e) => handleUpdateBlock(currentBlock.id, {colour: e.target.value})}
                                                title={currentBlock.colour ? '自定义颜色' : '当前跟随扩展主题色，点击可选任意颜色'}
                                            />
                                            {BLOCK_COLOURS.map(c => {
                                                // __THEME__：跟随扩展主题色。显示为主题色本身，
                                                // 点击 = 清空自定义色（回到 resolveBlockColour 的 fallback 分支）；
                                                // 高亮条件 = 当前实际生效色恰好是主题色且无自定义色。
                                                const isTheme = c === '__THEME__';
                                                // 高亮互斥：无自定义色时只亮主题格（即使主题色
                                                // 恰好与某预设同值）；有自定义色时只亮匹配的那格。
                                                const isActive = isTheme
                                                    ? !currentBlock.colour
                                                    : !!currentBlock.colour && currentBlock.colour.toLowerCase() === c.toLowerCase();
                                                return (
                                                    <button
                                                        key={c}
                                                        type="button"
                                                        className={'ext-block-colour-swatch' + (isActive ? ' ext-block-colour-swatch-active' : '')}
                                                        style={isTheme
                                                            ? {background: `linear-gradient(135deg, ${extInfo.color1}, ${extInfo.color2 || extInfo.color1})`}
                                                            : {background: c}}
                                                        onClick={() => handleUpdateBlock(currentBlock.id, {colour: isTheme ? '' : (currentBlock.colour === c ? '' : c)})}
                                                        title={isTheme ? '跟随扩展主题色' : c}
                                                    />
                                                );
                                            })}
                                            {!!currentBlock.colour && (
                                                <button
                                                    type="button"
                                                    className="ext-block-colour-clear"
                                                    onClick={() => handleUpdateBlock(currentBlock.id, {colour: ''})}
                                                >默认</button>
                                            )}
                                        </div>

                                        <div className="ext-block-editor-section">积木配置</div>
                                        <label className="ext-block-editor-checkbox">
                                            <input
                                                type="checkbox"
                                                checked={!!currentBlock.isTerminal}
                                                onChange={(e) => handleUpdateBlock(currentBlock.id, {isTerminal: e.target.checked})}
                                            />
                                            结尾积木
                                        </label>
                                        <label className="ext-block-editor-checkbox">
                                            <input
                                                type="checkbox"
                                                checked={!!currentBlock.isAsync}
                                                onChange={(e) => handleUpdateBlock(currentBlock.id, {isAsync: e.target.checked})}
                                            />
                                            异步积木
                                        </label>
                                        <label className="ext-block-editor-checkbox">
                                            <input
                                                type="checkbox"
                                                checked={!!currentBlock.attachAllThreads}
                                                onChange={(e) => handleUpdateBlock(currentBlock.id, {attachAllThreads: e.target.checked})}
                                            />
                                            附加所有线程
                                        </label>

                                        <div className="ext-block-editor-section">目标过滤</div>
                                        <label className="ext-block-editor-checkbox">
                                            <input
                                                type="checkbox"
                                                checked={!!currentBlock.filterSprite}
                                                onChange={(e) => handleUpdateBlock(currentBlock.id, {filterSprite: e.target.checked})}
                                            />
                                            在角色中显示
                                        </label>
                                        <label className="ext-block-editor-checkbox">
                                            <input
                                                type="checkbox"
                                                checked={!!currentBlock.filterStage}
                                                onChange={(e) => handleUpdateBlock(currentBlock.id, {filterStage: e.target.checked})}
                                            />
                                            在舞台中显示
                                        </label>

                                        <button
                                            type="button"
                                            className="ext-block-editor-icon-btn"
                                            onClick={() => currentBlock.icon
                                                ? handleClearBlockIcon(currentBlock.id)
                                                : handlePickBlockIcon(currentBlock.id)}
                                        >
                                            {currentBlock.icon ? '移除图标' : '上传积木图标'}
                                        </button>
                                    </div>

                                    <div className="ext-block-editor-hint">
                                        在右侧 Blockly 工作区拖入积木来定义此积木的代码实现
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Blockly's native workspace + toolbox */}
                <div className="ext-builder-workspace-full">
                    {loadError && (
                        <div className="ext-builder-load-error">
                            <p style={{color: '#f48771', padding: '8px'}}>
                                ⚠️ Blockly 加载失败: {loadError}
                            </p>
                        </div>
                    )}
                    <div ref={blocklyDivRef} className="blockly-host" />
                </div>

                {/* Right panel：JavaScript 代码常驻显示。
                    调试器是独立悬浮窗，不再占用这里，所以打开/关闭调试器
                    都不会让代码面板消失。 */}
                <div className="ext-builder-stage">
                    <div className="ext-stage-header">
                        <span className="ext-stage-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'6px'}}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>JavaScript 代码</span>
                        <div className="ext-stage-actions">
                            <button className="ext-stage-btn" onClick={handleOpenPreview} title="扩展积木预览">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                            </button>
                            <button className="ext-stage-btn ext-stage-btn-copy" onClick={handleCopyCode} title="复制完整代码，可直接粘贴到 TurboWarp">
                                {copyMsg ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2"><polyline points="20,6 9,17 4,12"/></svg> 已复制</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> 复制</>}
                            </button>
                            <button className="ext-stage-btn" onClick={handleExport} title="导出">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            </button>
                            <button className="ext-stage-btn" onClick={handleLoadExtension} title="加载">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            </button>
                            <button className="ext-stage-btn" onClick={handleReset} title="重置">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </div>
                    </div>

                    {/* Add block by category - removed (Blockly toolbox now handles drag-from-flyout) */}

                    <div className="ext-stage-screen">
                        <pre className="ext-code-content">
                            <code>{exportableCode || '// 拖入积木，JS 代码会自动生成在这里\n// Drag blocks into the workspace, JS will appear here'}</code>
                        </pre>
                    </div>
                    <div className="ext-stage-footer">
                        <div className="ext-stage-footer-left">
                            <button onClick={handleUndo} title="撤销"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H13"/></svg> 撤销</button>
                            <button onClick={handleRedo} title="重做"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17,1 21,5 17,9"/><path d="M3 11V9a4 4 0 014-4h14"/></svg> 重做</button>
                        </div>
                        <div className="ext-stage-footer-right">
                            <span className="ext-stat-item" title="代码行数"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg> {projectStats.lineCount} 行</span>
                            <span className="ext-stat-item" title="导出文件大小">{formatBytes(projectStats.fullSize)}</span>
                        </div>
                    </div>
                </div>
                </div>
            </div>

            {/* 统一设置面板（扩展设置 + 插件管理）— 实时协作风格悬浮框 */}
            {showSettingsPanel && settingsDraft && (
                <React.Fragment>
                {/* 自由拉伸层（8 方向手柄，面板打开时常驻显示） */}
                {!settingsMinimized && !settingsMaximized && (
                    <div className="ext-float-resize-layer" ref={settingsResizeLayerRef}>
                        {['n','s','e','w','ne','nw','se','sw'].map(dir => (
                            <div
                                key={dir}
                                className={`ext-float-resize-handle ext-fz-${dir}`}
                                onMouseDown={handleSettingsResizeDown(dir)}
                            />
                        ))}
                    </div>
                )}
                <div
                    ref={settingsPanelRef}
                    className={`ext-float-panel ext-settings-unified ${settingsMinimized ? 'ext-float-minimized' : ''}${settingsMaximized ? ' maximized' : ''}`}
                    style={{ display: settingsMinimized ? 'none' : '', zIndex: getZIndex('settings') }}
                    onMouseDown={(e) => { bringToFront('settings'); handleSettingsHeaderMouseDown(e); }}
                >
                    <div
                        className="ext-settings-unified-header ext-float-header"
                        onMouseDown={handleSettingsHeaderMouseDown}
                    >
                        <h2 className="ext-settings-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'6px'}}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>设置</h2>
                        <div className="ext-float-btns">
                            <button
                                type="button"
                                className="ext-float-btn"
                                onClick={handleSettingsToggleMin}
                                aria-label="最小化"
                                title="最小化"
                            >−</button>
                            <button
                                type="button"
                                className="ext-float-btn"
                                onClick={handleSettingsToggleMax}
                                aria-label={settingsMaximized ? '还原' : '最大化'}
                                title={settingsMaximized ? '还原' : '最大化'}
                            >{settingsMaximized ? '❐' : '□'}</button>
                            <button
                                type="button"
                                className="ext-float-btn ext-float-btn-close"
                                onClick={handleCloseSettings}
                                aria-label="关闭"
                                title="关闭"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>
                    </div>

                        {/* 主体：左侧竖排标签栏 + 右侧内容面板 */}
                        <div className="ext-settings-body">
                        <div className="ext-settings-sidebar">
                            <button
                                type="button"
                                className={`ext-settings-tab ${settingsTab === 'editor' ? 'active' : ''}`}
                                onClick={() => setSettingsTab('editor')}
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b6d85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>扩展设置</button>
                            <button
                                type="button"
                                className={`ext-settings-tab ${settingsTab === 'addons' ? 'active' : ''}`}
                                onClick={() => { setSettingsTab('addons'); setMarketView(false); }}
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b6d85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M12 3.5l2.6 5.3 5.9.86-4.25 4.14 1 5.86L12 16.92l-5.25 2.74 1-5.86L3.5 9.66l5.9-.86L12 3.5z"/></svg>插件管理</button>
                            <button
                                type="button"
                                className={`ext-settings-tab ${settingsTab === 'addons' && marketView ? 'active' : ''}`}
                                onClick={() => { setSettingsTab('addons'); handleOpenMarket(); }}
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b6d85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M4 7.5L6 4h12l2 3.5"/><path d="M4 7.5h16v10.5a2 2 0 01-2 2H6a2 2 0 01-2-2V7.5z"/><path d="M9.5 11.5a2.5 2.5 0 005 0"/></svg>插件市场</button>
                            <button
                                type="button"
                                className={`ext-settings-tab ${settingsTab === 'shortcuts' ? 'active' : ''}`}
                                onClick={() => setSettingsTab('shortcuts')}
                                title="查看全部快捷键"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b6d85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>快捷键</button>
                            <button
                                type="button"
                                className={`ext-settings-tab ${settingsTab === 'community' ? 'active' : ''}`}
                                onClick={() => setSettingsTab('community')}
                                title="浏览社区扩展 / 发布我的扩展"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b6d85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/></svg>社区</button>
                        </div>
                        <div className="ext-settings-panes">

                        {/* ===== 扩展设置标签页 ===== */}
                        {settingsTab === 'editor' && (
                            <div className="ext-settings-tab-content">
                        <div
                            className="ext-settings-banner"
                            style={{
                                background: `linear-gradient(135deg, ${settingsDraft.color1}, ${settingsDraft.color2}, ${settingsDraft.color3})`
                            }}
                        >
                            {settingsDraft.blockIcon ? (
                                <img src={settingsDraft.blockIcon} alt="icon" className="ext-settings-banner-icon" />
                            ) : (
                                <div className="ext-settings-banner-icon ext-settings-banner-placeholder">
                                    <svg width="34" height="34" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                                        {/* 四格积木：扩展构建器的语义化图形 */}
                                        <rect x="7"  y="7"  width="15" height="15" rx="4" fill="#ef476f"/>
                                        <rect x="26" y="7"  width="15" height="15" rx="4" fill="#ffb4a2"/>
                                        <rect x="7"  y="26" width="15" height="15" rx="4" fill="#f78da7"/>
                                        <rect x="26" y="26" width="15" height="15" rx="4" fill="#e5484d"/>
                                    </svg>
                                </div>
                            )}
                        </div>
                        <h2 className="ext-settings-title">创建扩展</h2>

                        <label className="ext-settings-label">名称</label>
                        <input
                            className="ext-settings-input"
                            value={settingsDraft.name}
                            placeholder="扩展名称..."
                            onChange={(e) => setSettingsDraft({...settingsDraft, name: e.target.value})}
                        />

                        <div className="ext-settings-id-preview">
                            {settingsDraft.customId ? settingsDraft.id : DEFAULT_EXTENSION_INFO.id}
                        </div>

                        <label className="ext-settings-checkbox">
                            <input
                                type="checkbox"
                                checked={settingsDraft.customId}
                                onChange={(e) => setSettingsDraft({
                                    ...settingsDraft,
                                    customId: e.target.checked,
                                    id: e.target.checked ? (settingsDraft.id || DEFAULT_EXTENSION_INFO.id) : DEFAULT_EXTENSION_INFO.id
                                })}
                            />
                            自定义ID?
                        </label>
                        {settingsDraft.customId && (
                            <input
                                className="ext-settings-input"
                                placeholder="扩展ID"
                                value={settingsDraft.id}
                                onChange={(e) => setSettingsDraft({...settingsDraft, id: e.target.value})}
                            />
                        )}

                        <label className="ext-settings-label">描述</label>
                        <input
                            className="ext-settings-input"
                            value={settingsDraft.description}
                            placeholder="扩展描述..."
                            onChange={(e) => setSettingsDraft({...settingsDraft, description: e.target.value})}
                        />

                        <label className="ext-settings-label">作者</label>
                        <input
                            className="ext-settings-input"
                            value={settingsDraft.author}
                            placeholder="作者名称..."
                            onChange={(e) => setSettingsDraft({...settingsDraft, author: e.target.value})}
                        />

                        <label className="ext-settings-label">文档链接</label>
                        <input
                            className="ext-settings-input"
                            value={settingsDraft.docsUrl}
                            placeholder="https://..."
                            onChange={(e) => setSettingsDraft({...settingsDraft, docsUrl: e.target.value})}
                        />

                        <label className="ext-settings-label">许可证</label>
                        <select
                            className="ext-settings-input"
                            value={settingsDraft.license}
                            onChange={(e) => setSettingsDraft({...settingsDraft, license: e.target.value})}
                        >
                            {LICENSE_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>

                        <div className="ext-settings-label-row">
                            <span className="ext-settings-label">自定义颜色:</span>
                            <input
                                type="color"
                                className="ext-settings-color-picker"
                                value={settingsDraft.color1}
                                onChange={(e) => {
                                    const c = e.target.value;
                                    setSettingsDraft({
                                        ...settingsDraft,
                                        color1: c,
                                        color2: c,
                                        color3: c
                                    });
                                }}
                            />
                        </div>
                        <div className="ext-settings-color-presets">
                            {COLOR_PRESETS.map((preset, i) => {
                                const active = preset[0] === settingsDraft.color1
                                    && preset[1] === settingsDraft.color2
                                    && preset[2] === settingsDraft.color3;
                                return (
                                    <button
                                        key={i}
                                        type="button"
                                        className={`ext-settings-color-swatch ${active ? 'active' : ''}`}
                                        onClick={() => handlePickColor(preset)}
                                        title={preset.join(', ')}
                                        style={{
                                            background: `linear-gradient(135deg, ${preset[0]}, ${preset[1]}, ${preset[2]})`
                                        }}
                                    />
                                );
                            })}
                        </div>

                        <div className="ext-settings-icon-row">
                            <div className="ext-settings-icon-cell">
                                <div className="ext-settings-label">分类图标</div>
                                <div className="ext-settings-icon-preview">
                                    {settingsDraft.categoryIcon ? (
                                        <img src={settingsDraft.categoryIcon} alt="category" />
                                    ) : (
                                        <span className="ext-settings-icon-empty">
                                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c3c6d4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-4.5-4.5L7 20"/></svg>
                                            <span>未选择图标</span>
                                        </span>
                                    )}
                                </div>
                                <div className="ext-settings-icon-actions">
                                    <button
                                        type="button"
                                        className="ext-settings-icon-btn"
                                        onClick={() => handlePickIcon('categoryIcon')}
                                    >上传</button>
                                    {settingsDraft.categoryIcon && (
                                        <button
                                            type="button"
                                            className="ext-settings-icon-clear"
                                            onClick={() => handleClearIcon('categoryIcon')}
                                        >清除</button>
                                    )}
                                </div>
                            </div>

                            <div className="ext-settings-icon-cell">
                                <div className="ext-settings-label">积木图标</div>
                                <div className="ext-settings-icon-preview">
                                    {settingsDraft.blockIcon ? (
                                        <img src={settingsDraft.blockIcon} alt="block" />
                                    ) : (
                                        <span className="ext-settings-icon-empty">
                                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c3c6d4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="10" rx="4"/><circle cx="9.5" cy="12" r="1.6"/><circle cx="14.5" cy="12" r="1.6"/><path d="M4 10.5H2.5M21.5 10.5H20" strokeLinecap="round"/></svg>
                                            <span>未选择图标</span>
                                        </span>
                                    )}
                                </div>
                                <div className="ext-settings-icon-actions">
                                    <button
                                        type="button"
                                        className="ext-settings-icon-btn"
                                        onClick={() => handlePickIcon('blockIcon')}
                                    >上传</button>
                                    {settingsDraft.blockIcon && (
                                        <button
                                            type="button"
                                            className="ext-settings-icon-clear"
                                            onClick={() => handleClearIcon('blockIcon')}
                                        >清除</button>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="ext-settings-actions">
                            <button
                                type="button"
                                className="ext-settings-cancel"
                                onClick={handleCloseSettings}
                            >取消</button>
                            <button
                                type="button"
                                className="ext-settings-done"
                                onClick={handleApplySettings}
                            >完成</button>
                        </div>
                            </div>
                        )}

                        {/* ===== 快捷键标签页 ===== */}
                        {settingsTab === 'shortcuts' && (
                            <div className="ext-settings-tab-content ext-shortcuts-tab-content">
                                <p className="ext-shortcuts-hint">以下快捷键在编辑器页面全局生效。标注「输入框内不可用」的组合键，是为了不干扰正常打字。</p>
                                <div className="ext-shortcuts-group">
                                    <div className="ext-shortcuts-group-title">文件与编辑</div>
                                    {[
                                        ['Ctrl + O', '加载扩展文件'],
                                        ['Ctrl + S', '导出扩展 JS'],
                                        ['Ctrl + Z', '撤销（输入框/工作区内不可用）'],
                                        ['Ctrl + Y', '重做（输入框/工作区内不可用）']
                                    ].map(([k, d]) => (
                                        <div key={k} className="ext-shortcuts-row">
                                            <span className="ext-shortcuts-desc">{d}</span>
                                            <kbd className="ext-shortcuts-key">{k}</kbd>
                                        </div>
                                    ))}
                                </div>
                                <div className="ext-shortcuts-group">
                                    <div className="ext-shortcuts-group-title">界面与工具</div>
                                    {[
                                        ['Ctrl + ,', '打开扩展设置'],
                                        ['Ctrl + Shift + B', '制作积木'],
                                        ['Ctrl + Shift + D', '调试器（Data URI 在线测试）'],
                                        ['Ctrl + Shift + P', '扩展积木预览'],
                                        ['Ctrl + Shift + C', '复制完整代码'],
                                        ['Ctrl + Shift + E', '打开插件市场'],
                                        ['Esc', '关闭设置面板（输入框内不可用）']
                                    ].map(([k, d]) => (
                                        <div key={k} className="ext-shortcuts-row">
                                            <span className="ext-shortcuts-desc">{d}</span>
                                            <kbd className="ext-shortcuts-key">{k}</kbd>
                                        </div>
                                    ))}
                                </div>
                                <p className="ext-shortcuts-hint">macOS 上 Ctrl 对应 ⌘ Command。</p>
                            </div>
                        )}

                        {/* ===== 社区标签页 ===== */}
                        {settingsTab === 'community' && (
                            <div className="ext-settings-tab-content" style={{display: 'flex', padding: 0, overflow: 'hidden'}}>
                                <CommunityPanel
                                    collectSnapshot={collectSnapshot}
                                    restoreSnapshot={restoreFromCommunity}
                                    session={session}
                                />
                            </div>
                        )}

                        {/* ===== 插件管理标签页 ===== */}
                        {settingsTab === 'addons' && (
                            <div className="ext-settings-tab-content ext-addons-tab-content">
                                {marketView ? (
                                    <div className="ext-market">
                                        <div className="ext-market-head">
                                            <button
                                                type="button"
                                                className="ext-market-back"
                                                onClick={() => setMarketView(false)}
                                                title="返回插件管理"
                                            >← 返回</button>
                                            <span className="ext-market-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><rect x="3" y="3" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v7"/><path d="M16 3v7"/></svg>插件市场</span>
                                            <span className="ext-market-repo">主题：{MARKET_TOPIC}</span>
                                            {!marketLoading && marketList.length > 0 && (
                                                <span className="ext-market-count">共 {marketList.length} 个</span>
                                            )}
                                            <button
                                                type="button"
                                                className="ext-market-refresh-btn"
                                                onClick={() => { setMarketList([]); handleOpenMarket(); }}
                                                disabled={marketLoading}
                                                title="刷新插件列表"
                                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg> 刷新</button>
                                        </div>
                                        {marketLoading && <div className="ext-market-loading">正在加载插件市场…</div>}
                                        {marketError && <div className="ext-market-error">⚠ {marketError}</div>}
                                        {!marketLoading && !marketError && marketList.length === 0 && (
                                            <div className="ext-market-empty">市场暂时没有可安装的插件</div>
                                        )}
                                        {!marketLoading && !marketError && marketList.length > 0 && (
                                        <div className="ext-market-grid">
                                            {marketList.map(item => (
                                                <div key={item.source} className="ext-market-card">
                                                    <div className="ext-market-card-name">{item.name}</div>
                                                    <div className="ext-market-card-cat">{item.category}</div>
                                                    <div className="ext-market-card-repo">{item.repoOwner}/{item.repoName}</div>
                                                    <div className="ext-market-card-desc">{item.description}</div>
                                                    {item.hasServer && (
                                                        <div className="ext-market-card-cat" title="安装后会在本机插件目录落盘，并拉起一个只监听 127.0.0.1 的 Node 服务">含本地服务</div>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className={`ext-market-install-btn ${marketInstalled[item.dir] ? 'installed' : ''}`}
                                                        disabled={marketInstalled[item.dir] || marketInstalling === item.dir}
                                                        onClick={() => handleMarketInstall(item)}
                                                    >
                                                        {marketInstalled[item.dir] ? '已安装' : (marketInstalling === item.dir ? '安装中…' : '安装')}
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                        )}
                                    </div>
                                ) : (
                                <div>
                                <div className="ext-addons-search">
                                    <input
                                        type="search"
                                        className="ext-addons-search-input"
                                        placeholder="搜索插件..."
                                        value={addonSearch}
                                        onChange={(e) => setAddonSearch(e.target.value)}
                                    />
                                </div>
                                <div className="ext-addons-list">
                                    {addonList
                                        .filter(addon => {
                                            if (!addonSearch.trim()) return true;
                                            const q = addonSearch.trim().toLowerCase();
                                            return addon.name.toLowerCase().indexOf(q) >= 0 ||
                                                addon.description.toLowerCase().indexOf(q) >= 0 ||
                                                addon.category.toLowerCase().indexOf(q) >= 0;
                                        })
                                        .map(addon => (
                                        <div key={addon.id} className="ext-addon-item">
                                            <label className="ext-addon-label">
                                                <input
                                                    type="checkbox"
                                                    className="ext-addon-check"
                                                    checked={!!addonState[addon.id]}
                                                    disabled={!!addon.locked}
                                                    onChange={(e) => handleToggleAddon(addon.id, e.target.checked)}
                                                />
                                                <span className="ext-addon-name">{addon.name}</span>
                                                {addon.recommended && <span className="ext-addon-recommend">推荐</span>}
                                                {addon.builtin && <span className="ext-addon-builtin">内置</span>}
                                                <span className="ext-addon-cat">{addon.category}</span>
                                                {addon.custom && (
                                                    <span className="ext-addon-source">来自：{addon.source || '本地文件'}</span>
                                                )}
                                                {addon.custom && (
                                                    <button
                                                        type="button"
                                                        className="ext-addon-del"
                                                        title="删除此自定义插件"
                                                        aria-label="删除自定义插件"
                                                        onClick={() => handleRemoveCustomAddon(addon.id)}
                                                    >删除</button>
                                                )}
                                                {/* 数据目录插件：删的是磁盘上的目录，走后端。
                                                    内置的（随编辑器分发）不给按钮 —— 删了下次启动会被
                                                    deployBundled() 铺回来，后端也会拒，见 removePlugin()。 */}
                                                {addon.dirPlugin && !addon.dirBundled && (
                                                    <button
                                                        type="button"
                                                        className="ext-addon-del"
                                                        title="删除此插件（会连同它的目录一起删掉）"
                                                        aria-label="删除插件"
                                                        onClick={() => handleRemoveDirPlugin(addon)}
                                                    >删除</button>
                                                )}
                                                {addon.dirPlugin && addon.dirBundled && (
                                                    <span
                                                        className="ext-addon-del-locked"
                                                        title="随编辑器分发的内置插件，不能删除"
                                                    >内置·不可删</span>
                                                )}
                                                {addon.custom && addon.source && (
                                                    <button
                                                        type="button"
                                                        className="ext-addon-update"
                                                        title="按来源重新拉取并更新"
                                                        aria-label="更新插件"
                                                        onClick={() => handleUpdateAddon(addon.id)}
                                                    >更新</button>
                                                )}
                                            </label>
                                            <div className="ext-addon-desc">{addon.description}</div>
                                            {addonState[addon.id] && addon.options && addon.options.length > 0 && (
                                                <div className="ext-addon-opts">
                                                    {addon.options.map(opt => (
                                                        <label key={opt.id} className="ext-addon-opt-item">
                                                            <input
                                                                type="checkbox"
                                                                className="ext-addon-opt-check"
                                                                checked={!!(addonOpts[addon.id] && addonOpts[addon.id][opt.id])}
                                                                onChange={(e) => handleToggleAddonOption(addon.id, opt.id, e.target.checked)}
                                                            />
                                                            <span className="ext-opt-label">{opt.label}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                    {addonList.filter(addon => {
                                        if (!addonSearch.trim()) return true;
                                        const q = addonSearch.trim().toLowerCase();
                                        return addon.name.toLowerCase().indexOf(q) >= 0 ||
                                            addon.description.toLowerCase().indexOf(q) >= 0 ||
                                            addon.category.toLowerCase().indexOf(q) >= 0;
                                    }).length === 0 && (
                                        <div className="ext-addon-empty">没有匹配的插件</div>
                                    )}
                                </div>
                                <div className="ext-addons-actions">
                                    <button
                                        type="button"
                                        className="ext-addons-action-btn ext-addons-action-btn-primary"
                                        onClick={() => { setInstallError(''); setInstallStatus(''); setInstallSource(''); setShowInstallModal(true); }}
                                        title="从 npm / GitHub / 直链 / 本地文件安装插件（对齐 DeepSeek Harness 的 dsh plugin add）"
                                    >安装插件</button>
                                    <button
                                        type="button"
                                        className="ext-addons-action-btn ext-addons-action-btn-info"
                                        onClick={() => window.open('ext-addons-doc.html', '_blank')}
                                        title="打开插件开发文档与使用教程（独立页面）"
                                    >开发教程</button>
                                    <button
                                        type="button"
                                        className="ext-addons-action-btn"
                                        onClick={handleAddonExport}
                                    >导出设置</button>
                                    <button
                                        type="button"
                                        className="ext-addons-action-btn"
                                        onClick={handleAddonImport}
                                    >导入设置</button>
                                    <button
                                        type="button"
                                        className="ext-addons-action-btn ext-addons-action-btn-warn"
                                        onClick={handleAddonReset}
                                    >全部重置</button>
                                </div>
                                <div className="ext-addons-foot">
                                    <button
                                        type="button"
                                        className="ext-auth-btn"
                                        onClick={handleCloseSettings}
                                    >完成</button>
                                </div>
                                </div>
                                )}
                            </div>
                        )}
                        </div>
                        </div>
                    </div>
                </React.Fragment>
            )}

            {/* Block preview modal (mimics AstraEditor "扩展预览") */}
            <div
                className="ext-preview-host"
                ref={previewHostRef}
                aria-hidden="true"
            />
            {showBlockPreview && (
                <div className="ext-modal-backdrop" onClick={handleClosePreview}>
                    <div
                        className="ext-modal ext-preview-modal"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="ext-preview-modal-header">
                            <h2 className="ext-settings-title">扩展积木预览</h2>
                            <button
                                type="button"
                                className="ext-preview-modal-close"
                                onClick={handleClosePreview}
                                aria-label="关闭预览"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>
                        <div className="ext-preview-modal-sub">
                            <span className="ext-preview-ext-name">{extInfo.name}</span>
                            <span className="ext-preview-block-count">共 {previewBlocks.length} 个积木</span>
                        </div>
                        <div className="ext-preview-list">
                            {previewBlocks.length === 0 ? (
                                <div className="ext-preview-empty">没有可预览的积木</div>
                            ) : (
                                previewBlocks.map((b, i) => (
                                    <div
                                        key={b.type + i}
                                        className="ext-preview-item"
                                        title={b.type}
                                    >
                                        <div className="ext-preview-item-type">{b.type}</div>
                                        <div
                                            className="ext-preview-item-svg"
                                            dangerouslySetInnerHTML={{__html: b.svgXml}}
                                        />
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* GitHub 登录弹窗：PAT 粘贴登录（主）+ Device Flow（本地开发折叠项）。
                没有 redirect、不需要回调页，全程在本页完成。 */}
            {(deviceFlow || patLogin.showForm) && (
                <div
                    className="ext-auth-backdrop"
                    onClick={(e) => { if (e.target === e.currentTarget) { stopDeviceFlow(); setPatLogin({busy: false, error: '', showForm: false}); } }}
                >
                    <div className="ext-auth-card ext-device-card">
                        <div className="ext-auth-header">
                            <span className="ext-auth-title">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{verticalAlign:'middle',marginRight:'6px'}}><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 015.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0023.5 12C23.5 5.73 18.27.5 12 .5z"/></svg>
                                GitHub 登录
                            </span>
                            <button
                                type="button"
                                className="ext-builder-modal-close"
                                onClick={() => { stopDeviceFlow(); setPatLogin({busy: false, error: '', showForm: false}); }}
                                aria-label="关闭"
                                title="取消登录"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>
                        <div className="ext-device-body">
                            {/* ── PAT 粘贴登录（唯一线上入口）──
                                线上是 GitHub Pages，Device Flow 的 POST 无法代理；
                                PAT 走 api.github.com（自带 CORS），任何环境都能用。
                                弹窗内始终显示表单 —— 之前用 showForm 三态切换，
                                会在 Device Flow error 残留时误显「已登录」死状态。 */}
                            <div className="ext-device-hint">
                                粘贴 GitHub <b>Personal Access Token</b> 完成登录（
                                <a href="https://github.com/settings/tokens/new?scopes=user:email,gist&description=ForgeExt" target="_blank" rel="noopener noreferrer">点此创建</a>
                                ，勾选 <code>user:email</code> 和 <code>gist</code>（发布社区需要））。
                            </div>
                            <input
                                type="password"
                                className="ext-auth-input"
                                ref={patInputRef}
                                placeholder="ghp_… 或 github_pat_…"
                                autoComplete="off"
                                onKeyDown={(e) => { if (e.key === 'Enter') handlePatLogin(); }}
                            />
                            {patLogin.error && <div className="ext-auth-error">{patLogin.error}</div>}
                            <button
                                type="button"
                                className="ext-auth-btn"
                                onClick={handlePatLogin}
                                disabled={patLogin.busy}
                            >{patLogin.busy ? '验证中…' : '登录'}</button>
                            <div className="ext-legal-foot">
                                Token 只保存在本页会话（sessionStorage），关闭浏览器即失效，不会长期保存。
                            </div>

                            {/* ── Device Flow（本地 devServer 备选）── */}
                            <details className="ext-device-alt">
                                <summary>本地开发模式（Device Flow）</summary>
                                {deviceFlow.status === 'starting' && (
                                    <div className="ext-device-hint">正在向 GitHub 申请设备码…</div>
                                )}

                            {deviceFlow.status === 'waiting' && (
                                <React.Fragment>
                                    <div className="ext-device-hint">
                                        在 GitHub 页面输入下面的用户码并确认授权：
                                    </div>
                                    <div className="ext-device-code-row">
                                        <code className="ext-device-code">{deviceFlow.userCode}</code>
                                        <button
                                            type="button"
                                            className="ext-device-copy"
                                            onClick={() => {
                                                const t = deviceFlow.userCode;
                                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                                    navigator.clipboard.writeText(t).catch(() => {});
                                                } else {
                                                    const ta = document.createElement('textarea');
                                                    ta.value = t;
                                                    document.body.appendChild(ta);
                                                    ta.select();
                                                    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
                                                    document.body.removeChild(ta);
                                                }
                                            }}
                                        >复制</button>
                                    </div>
                                    <div className="ext-device-steps">
                                        <ol>
                                            <li>已尝试自动打开 <code>github.com/login/device</code>；若没打开，点下面的按钮。</li>
                                            <li>粘贴上面的用户码，点「Continue」。</li>
                                            <li>点「Authorize」同意授权，本页会自动完成登录。</li>
                                        </ol>
                                    </div>
                                    <button
                                        type="button"
                                        className="ext-auth-btn"
                                        onClick={() => window.open(deviceFlow.verificationUri, 'github-device', 'width=600,height=720')}
                                    >打开 GitHub 授权页</button>
                                    <div className="ext-device-waiting">
                                        <span className="ext-device-spinner" aria-hidden="true"></span>
                                        等待授权中…（本窗口保持打开即可）
                                    </div>
                                    {/* 条款已在发起授权前确认过，这里只留可随时回看的入口 */}
                                    <div className="ext-legal-foot">
                                        你已同意
                                        <button type="button" className="ext-legal-link" onClick={() => setLegalModal('terms')}>《用户协议》</button>
                                        与
                                        <button type="button" className="ext-legal-link" onClick={() => setLegalModal('privacy')}>《隐私政策》</button>
                                    </div>
                                </React.Fragment>
                            )}

                            {deviceFlow.status === 'error' && (
                                <React.Fragment>
                                    <div className="ext-auth-error">{deviceFlow.error}</div>
                                    <div className="ext-device-hint">
                                        线上（GitHub Pages）无法代理 Device Flow，请改用上方的 Token 登录。
                                        本地开发（127.0.0.1）下此流程可用；若仍报 device_flow_disabled，
                                        到 GitHub → Settings → Developer settings → OAuth Apps 勾选 Enable Device Flow。
                                    </div>
                                    <button
                                        type="button"
                                        className="ext-auth-btn"
                                        onClick={() => { stopDeviceFlow(); handleGitHubLogin(); }}
                                    >重试</button>
                                </React.Fragment>
                            )}
                            </details>
                        </div>
                    </div>
                </div>
            )}

            {/* 用户协议 / 隐私政策弹窗。
                从登录流程或授权弹窗里的链接打开；正文来自 lib/legal-docs.js，
                与网站上的条款页是同一份内容，不再把人踢去别的域名。 */}
            {legalModal && LEGAL_DOCS[legalModal] && (
                <div
                    className="ext-legal-backdrop"
                    onClick={(e) => { if (e.target === e.currentTarget) setLegalModal(null); }}
                >
                    <div className="ext-legal-card">
                        <div className="ext-auth-header">
                            <span className="ext-auth-title">{LEGAL_DOCS[legalModal].title}</span>
                            <button
                                type="button"
                                className="ext-builder-modal-close"
                                onClick={() => setLegalModal(null)}
                                aria-label="关闭"
                                title="关闭"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>

                        <div className="ext-legal-body">
                            <div className="ext-legal-meta">更新日期：{LEGAL_DOCS[legalModal].updated}</div>
                            <p className="ext-legal-intro">{LEGAL_DOCS[legalModal].intro}</p>
                            {LEGAL_DOCS[legalModal].sections.map((sec) => (
                                <div className="ext-legal-section" key={sec.h}>
                                    <h3 className="ext-legal-h">{sec.h}</h3>
                                    {sec.p.map((para, i) => (
                                        <p className="ext-legal-p" key={i}>{para}</p>
                                    ))}
                                </div>
                            ))}
                        </div>

                        <div className="ext-legal-actions">
                            {legalModal === 'terms' && !legalAgreed && (
                                <button
                                    type="button"
                                    className="ext-legal-agree"
                                    onClick={() => {
                                        setLegalAgreed(true);
                                        setLegalModal(null);
                                        // 用户本意是登录，被条款拦下的：同意后直接接着走。
                                        // 主入口是 PAT 粘贴登录（Device Flow 线上不可用，
                                        // 已降级为登录弹窗里的本地开发折叠项）。
                                        if (pendingLoginRef.current) {
                                            pendingLoginRef.current = false;
                                            setPatLogin({busy: false, error: '', showForm: true});
                                        }
                                    }}
                                >同意并继续</button>
                            )}
                            <button
                                type="button"
                                className="ext-legal-close"
                                onClick={() => { pendingLoginRef.current = false; setLegalModal(null); }}
                            >关闭</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 安装插件 — 悬浮框 */}
            {showInstallModal && (
                <div
                    ref={installPanelRef}
                    className={`ext-float-panel ext-install-panel${installMinimized ? ' ext-float-minimized' : ''}${installMaximized ? ' maximized' : ''}`}
                    style={{left: installFloatBounds.x, top: installFloatBounds.y, width: installFloatBounds.w, height: installFloatBounds.h, display: installMinimized ? 'none' : '', zIndex: getZIndex('install')}}
                    onMouseDown={() => bringToFront('install')}
                >
                    <div className="ext-float-header" onMouseDown={(e) => handleInstallDragStart(e)}>
                        <span className="ext-float-title">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                            安装插件
                        </span>
                        <div className="ext-float-btns">
                            <button className="ext-float-btn" onClick={() => setInstallMinimized(v => !v)} title={installMinimized ? '还原' : '最小化'}>−</button>
                            <button className="ext-float-btn" onClick={() => setInstallMaximized(v => !v)} title={installMaximized ? '还原' : '最大化'}>{installMaximized ? '❐' : '□'}</button>
                            <button className="ext-float-btn ext-float-btn-close" onClick={() => setShowInstallModal(false)} title="关闭">×</button>
                        </div>
                    </div>
                    <div className="ext-install-body">
                        <div className="ext-install-hint">
                            输入 npm 包名、github 仓库、直链 URL，按 Enter 安装。输入 <code>help</code> 查看支持的格式。
                        </div>
                        <div className="ext-install-output" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
                            {installLog.map((line, i) => (
                                <div key={i} className={`ext-install-line ${line.type}`}>{line.text}</div>
                            ))}
                            {installLoading && <div className="ext-install-line info">⏳ 安装中...</div>}
                        </div>
                        <div className="ext-install-input-row">
                            <span className="ext-install-prompt">$</span>
                            <input
                                type="text"
                                className="ext-install-input"
                                placeholder="npm install <package>  或直接输入包名"
                                value={installSource}
                                onChange={(e) => setInstallSource(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !installLoading && installSource.trim()) {
                                        const cmd = installSource.trim();
                                        if (cmd === 'help' || cmd === '?') {
                                            setInstallLog(prev => [...prev,
                                                {type: 'info', text: '支持的安装源：'},
                                                {type: 'info', text: '  npm: <包名>  或  npm install <包名>'},
                                                {type: 'info', text: '  github: <owner/repo>  或  <owner/repo>'},
                                                {type: 'info', text: '  url: <https://…/plugin.js>'},
                                                {type: 'info', text: '  本地文件：点击下方按钮选择'},
                                            ]);
                                            setInstallSource('');
                                            return;
                                        }
                                        const pkg = cmd.replace(/^npm\s+install\s+/i, '');
                                        setInstallLog(prev => [...prev, {type: 'cmd', text: '$ ' + cmd}]);
                                        setInstallSource('');
                                        handleInstallFromSource(pkg);
                                    }
                                }}
                                autoFocus
                            />
                        </div>
                        <div className="ext-install-toolbar">
                            <button type="button" className="ext-install-tool-btn" disabled={installLoading} onClick={() => handleInstallLocalFile('file')}>📄 JS</button>
                            <button type="button" className="ext-install-tool-btn" disabled={installLoading} onClick={() => handleInstallLocalFile('folder')}>📁 文件夹</button>
                            <button type="button" className="ext-install-tool-btn" disabled={installLoading} onClick={() => handleInstallLocalFile('zip')}>📦 ZIP</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 插件开发与使用教程已移至独立页面：ext-addons-doc.html */}


            {/* 用户面板悬浮框 */}
            {userPanelType && session && (
                <React.Fragment>
                {userResizeLayerOn && !userMinimized && (
                    <div className="ext-float-resize-layer">
                        {['n','s','e','w','ne','nw','se','sw'].map(dir => (
                            <div key={dir} className={"ext-fz-" + dir} onMouseDown={handleUserResizeDown(dir)} />
                        ))}
                    </div>
                )}
                <div
                    ref={userFloatRef}
                    className={`ext-float-panel ${userMinimized ? 'ext-float-minimized' : ''}${userMaximized ? ' maximized' : ''}`}
                    style={{ display: userMinimized ? 'none' : '', left: userFloatBounds.x, top: userFloatBounds.y, width: userFloatBounds.w, height: userFloatBounds.h, zIndex: getZIndex('user') }}
                    onMouseDown={(e) => { bringToFront('user'); handleUserHeaderMouseDown(e); }}
                >
                    <div className="ext-float-header">
                        <span className="ext-float-title">
                            {userPanelType === 'profile' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'6px'}}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>个人主页</>}
                            {userPanelType === 'friends' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'6px'}}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>好友 / 关注</>}
                            {userPanelType === 'saves' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'6px'}}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,9 15,9"/></svg>存档管理</>}
                        </span>
                        <div className="ext-float-btns">
                            <button type="button" className="ext-float-btn" onClick={handleUserToggleMin} title="最小化">−</button>
                            <button type="button" className="ext-float-btn" onClick={handleUserToggleMax} aria-label={userMaximized ? '还原' : '最大化'} title={userMaximized ? '还原' : '最大化'}>{userMaximized ? '❐' : '□'}</button>
                            <button type="button" className="ext-float-btn" onClick={closeUserPanel} aria-label="关闭" title="关闭"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>
                    </div>
                    <div className="ext-float-body" style={{overflow:'auto'}}>
                        {/* 从 friendsRelations 推导好友/关注/粉丝列表 */}
                        {(() => {
                            const me = session ? session.username : '';
                            const following = [], followers = [];
                            const fwd = new Set(), bwd = new Set();
                            for (const r of friendsRelations) {
                                if (r.follower === me) { following.push(r.followee); fwd.add(r.followee); }
                                if (r.followee === me) { followers.push(r.follower); bwd.add(r.follower); }
                            }
                            // 互关 = 好友
                            const friendSet = new Set([...fwd].filter(u => bwd.has(u)));
                            const emptyText = friendsTab === 'friends' ? '暂无好友' : friendsTab === 'following' ? '你还没有关注任何人' : '还没有人关注你';
                            let listItems = [];
                            if (friendsTab === 'friends') listItems = [...friendSet].map(u => ({u, followBack: false, action: 'unfriend', label: '解除好友'}));
                            else if (friendsTab === 'following') listItems = following.map(u => ({u, followBack: bwd.has(u), action: 'unfollow-following', label: '取消关注'}));
                            else listItems = followers.map(u => ({u, followBack: fwd.has(u), action: 'unfollow-follower', label: '移除粉丝'}));
                            // 将推导结果挂到 window 上供闭包内 JSX 使用（避免在 return 外声明额外 state）
                            window.__extFriends = { friendSet, following, followers, listItems, emptyText };
                            return null;
                        })()}
                        {userPanelType === 'friends' && (
                    <div className="ext-float-content">
                        <div className="ext-friends-intro">
                            关注他人即可建立联系；互相关注会自动成为好友。数据存储在云端，跨设备同步。
                        </div>
                        {!cloudAvailable() && (
                            <div className="ext-friends-msg">⚠️ 云端未启用，好友功能暂不可用。请检查 supabase-config.js 的 Supabase 配置。</div>
                        )}

                        {/* 搜索添加 */}
                        <div className="ext-friends-search">
                            <input
                                type="search"
                                className="ext-friends-search-input"
                                placeholder="输入用户名搜索用户…"
                                value={friendsSearch}
                                onChange={(e) => setFriendsSearch(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleFriendSearch(); }}
                            />
                            <button
                                type="button"
                                className="ext-friends-search-btn"
                                onClick={handleFriendSearch}
                                disabled={friendsBusy}
                            >搜索</button>
                        </div>
                        {friendsResults.length > 0 && (
                            <div className="ext-friends-results">
                                {friendsResults.map(r => {
                                    const isFollowing = (window.__extFriends ? window.__extFriends.following : []).indexOf(r.username) >= 0;
                                    return (
                                        <div key={r.username} className="ext-friends-item">
                                            <span className="ext-friends-name">{r.username}</span>
                                            <button
                                                type="button"
                                                className={'ext-friends-btn' + (isFollowing ? ' ext-friends-btn-done' : '')}
                                                disabled={friendsBusy}
                                                onClick={() => handleFriendAction(r.username, isFollowing ? 'unfollow-following' : 'follow')}
                                            >{isFollowing ? '已关注 ✓' : '关注'}</button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* 分组标签 */}
                        <div className="ext-friends-tabs">
                            <button
                                type="button"
                                className={'ext-friends-tab' + (friendsTab === 'friends' ? ' ext-friends-tab-active' : '')}
                                onClick={() => setFriendsTab('friends')}
                            >好友 ({(window.__extFriends ? window.__extFriends.friendSet : new Set()).length})</button>
                            <button
                                type="button"
                                className={'ext-friends-tab' + (friendsTab === 'following' ? ' ext-friends-tab-active' : '')}
                                onClick={() => setFriendsTab('following')}
                            >我关注的 ({(window.__extFriends ? window.__extFriends.following : []).length})</button>
                            <button
                                type="button"
                                className={'ext-friends-tab' + (friendsTab === 'followers' ? ' ext-friends-tab-active' : '')}
                                onClick={() => setFriendsTab('followers')}
                            >关注我的 ({(window.__extFriends ? window.__extFriends.followers : []).length})</button>
                        </div>

                        {/* 列表 */}
                        <div className="ext-friends-list">
                            {(window.__extFriends ? window.__extFriends.listItems : []).length === 0 ? (
                                <div className="ext-friends-empty">{window.__extFriends ? window.__extFriends.emptyText : ''}</div>
                            ) : (
                                (window.__extFriends ? window.__extFriends.listItems : []).map((it) => (
                                    <div key={it.u} className="ext-friends-item">
                                        <span className="ext-friends-name">{it.u}</span>
                                        <span className="ext-friends-actions">
                                            {it.followBack && (
                                                <button
                                                    type="button"
                                                    className="ext-friends-btn"
                                                    disabled={friendsBusy}
                                                    onClick={() => handleFriendAction(it.u, 'follow')}
                                                >回关</button>
                                            )}
                                            <button
                                                type="button"
                                                className="ext-friends-btn ext-friends-btn-warn"
                                                disabled={friendsBusy}
                                                onClick={() => handleFriendAction(it.u, it.action)}
                                            >{it.label}</button>
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>

                        {friendsMsg && <div className="ext-friends-msg">{friendsMsg}</div>}
                    </div>
                        )}
                        {userPanelType === 'profile' && (
                    <div className="ext-profile-body">
                            <div className="ext-profile-head">
                                <div className="ext-profile-avatar">
                                    {(session.username || '?').charAt(0).toUpperCase()}
                                </div>
                                <div className="ext-profile-info">
                                    <div className="ext-profile-name">{session.username}</div>
                                    <div className="ext-profile-email">
                                        {profileMeta && profileMeta.email ? profileMeta.email : ''}
                                    </div>
                                </div>
                            </div>
                            <div className="ext-profile-stats">
                                <div className="ext-profile-stat">
                                    <span className="ext-profile-stat-num">
                                        {Array.isArray(savesList) ? savesList.length : 0}
                                    </span>
                                    <span className="ext-profile-stat-label">存档</span>
                                </div>
                                <div className="ext-profile-stat">
                                    <span className="ext-profile-stat-num">
                                        {customBlocks.length}
                                    </span>
                                    <span className="ext-profile-stat-label">积木</span>
                                </div>
                                <div className="ext-profile-stat">
                                    <span className="ext-profile-stat-num">1</span>
                                    <span className="ext-profile-stat-label">扩展</span>
                                </div>
                                <div className="ext-profile-stat">
                                    <span className="ext-profile-stat-num">{profileCounts.following}</span>
                                    <span className="ext-profile-stat-label">关注</span>
                                </div>
                                <div className="ext-profile-stat">
                                    <span className="ext-profile-stat-num">{profileCounts.followers}</span>
                                    <span className="ext-profile-stat-label">粉丝</span>
                                </div>
                            </div>
                            <div className="ext-profile-joined">
                                注册时间：
                                {profileMeta && profileMeta.createdAt
                                    ? new Date(profileMeta.createdAt).toLocaleString()
                                    : '未知'}
                            </div>
                            <div className="ext-profile-saves-title">我的存档</div>
                            <div className="ext-profile-saves">
                                {Array.isArray(savesList) && savesList.length > 0 ? (
                                    savesList.map(save => (
                                        <div key={save.id} className="ext-profile-save-item">
                                            <div className="ext-profile-save-info">
                                                <div className="ext-profile-save-name">{save.name || '未命名存档'}</div>
                                                <div className="ext-profile-save-time">
                                                    {new Date(save.updatedAt || Date.now()).toLocaleString()}
                                                </div>
                                            </div>
                                            <div className="ext-profile-save-actions">
                                                <button
                                                    type="button"
                                                    className="ext-profile-save-btn"
                                                    onClick={() => handleLoadSave(save)}
                                                    title="加载此存档"
                                                >加载</button>
                                                <button
                                                    type="button"
                                                    className="ext-profile-save-btn ext-profile-save-btn-del"
                                                    onClick={() => handleDeleteSave(save.id)}
                                                    title="删除此存档"
                                                >删除</button>
                                            </div>
                                        </div>
                                    ))
                                ) : (
                                    <div className="ext-profile-saves-empty">还没有存档，点击顶部 💾 存档 按钮保存项目</div>
                                )}
                            </div>
                        </div>
                        )}
                        {userPanelType === 'saves' && (
                        <div className="ext-saves-body">
                            <div className="ext-saves-new">
                                <input
                                    className="ext-auth-input ext-saves-name-input"
                                    value={saveNameInput}
                                    onChange={(e) => setSaveNameInput(e.target.value)}
                                    placeholder="存档名称（留空自动命名）"
                                />
                                <button className="ext-auth-btn ext-saves-save-btn" onClick={handleSaveProject}>
                                    保存当前项目
                                </button>
                            </div>
                            {saveMsg && <div className="ext-saves-msg">{saveMsg}</div>}
                            <div className="ext-saves-list-title">我的存档（{savesList.length}）</div>
                            {savesList.length === 0 && (
                                <div className="ext-saves-empty">还没有存档，点击上方按钮保存当前项目。</div>
                            )}
                            <div className="ext-saves-list">
                                {savesList.map(save => (
                                    <div className="ext-saves-item" key={save.id}>
                                        <div className="ext-saves-item-info">
                                            <div className="ext-saves-item-name" title={save.name}>{save.name}</div>
                                            <div className="ext-saves-item-time">
                                                {new Date(save.updatedAt).toLocaleString()}
                                            </div>
                                        </div>
                                        <div className="ext-saves-item-actions">
                                            <button
                                                className="ext-saves-act"
                                                title="加载此存档"
                                                onClick={() => handleLoadSave(save)}
                                            >加载</button>
                                            <button
                                                className="ext-saves-act"
                                                title="用当前项目覆盖此存档"
                                                onClick={() => handleOverwriteSave(save.id)}
                                            >覆盖</button>
                                            <button
                                                className="ext-saves-act"
                                                title="导出为 JSON 文件"
                                                onClick={() => exportSaveFile(save)}
                                            >导出</button>
                                            <button
                                                className="ext-saves-act ext-saves-act-del"
                                                title="删除此存档"
                                                onClick={() => handleDeleteSave(save.id)}
                                            >删除</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="ext-sync-section">
                                <div className="ext-sync-title">🔗 跨站互通（同步链接）</div>
                                <p className="ext-sync-hint">
                                    在两个部署（例如平台应用与自定义域名）之间互通登录与存档：
                                    在本站生成同步链接，在另一个网站打开该链接即可导入账号与存档，
                                    两边数据保持一致，可双向重复同步。
                                </p>
                                <button className="ext-auth-btn" onClick={handleGenSync}>生成同步链接</button>
                                {syncLinkText && (
                                    <div className="ext-sync-link-box">
                                        <textarea
                                            className="ext-sync-link"
                                            readOnly
                                            value={syncLinkText}
                                            onFocus={(e) => e.target.select()}
                                            rows={3}
                                        />
                                        <button
                                            className="ext-saves-act"
                                            onClick={() => {
                                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                                    navigator.clipboard.writeText(syncLinkText)
                                                        .then(() => alert('已复制同步链接'))
                                                        .catch(() => alert('复制失败，请手动选择复制'));
                                                } else {
                                                    alert('复制失败，请手动选择复制');
                                                }
                                            }}
                                        >复制</button>
                                    </div>
                                )}
                                <div className="ext-sync-import">
                                    <input
                                        className="ext-auth-input"
                                        value={syncInput}
                                        onChange={(e) => setSyncInput(e.target.value)}
                                        placeholder="粘贴对方网站的同步链接（或 #sync= 部分）"
                                    />
                                    <button className="ext-auth-btn" onClick={handleImportSync}>导入对方同步</button>
                                </div>
                                <div className="ext-sync-file">
                                    <button className="ext-saves-act" onClick={handleImportSaveFile}>
                                        导入存档文件(.json)
                                    </button>
                                </div>
                            </div>
                        </div>
                        )}
                    </div>
                </div>
                </React.Fragment>
            )}

            {/* 调试器（悬浮框，可拖拽/拉伸/最大化/最小化/关闭） */}
            {showDebuggerPanel && (
                <React.Fragment>
                {!debuggerMinimized && !debuggerMaximized && (
                    <div className="ext-float-resize-layer" ref={debuggerResizeLayerRef}>
                        {['n','s','e','w','ne','nw','se','sw'].map(dir => (
                            <div
                                key={dir}
                                className={`ext-float-resize-handle ext-fz-${dir}`}
                                onMouseDown={handleDebuggerResizeDown(dir)}
                            />
                        ))}
                    </div>
                )}
                <div
                    ref={debuggerPanelRef}
                    className={`ext-float-panel ext-debugger-panel${debuggerMinimized ? ' ext-float-minimized' : ''}${debuggerMaximized ? ' maximized' : ''}`}
                    style={{
                        left: debuggerFloatBounds.x,
                        top: debuggerFloatBounds.y,
                        width: debuggerFloatBounds.w,
                        height: debuggerFloatBounds.h,
                        display: debuggerMinimized ? 'none' : '',
                        zIndex: getZIndex('debugger')
                    }}
                    onMouseDown={(e) => { bringToFront('debugger'); handleDebuggerHeaderMouseDown(e); }}
                >
                    <div className="ext-float-header" onMouseDown={handleDebuggerHeaderMouseDown}>
                        <span className="ext-float-title">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'6px'}}>
                                <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/><circle cx="12" cy="12" r="3"/>
                            </svg>
                            调试器
                        </span>
                        <div className="ext-float-btns">
                            <button
                                type="button"
                                className="ext-float-btn"
                                onClick={handleDebuggerToggleMin}
                                aria-label="最小化"
                                title="最小化"
                            >−</button>
                            <button
                                type="button"
                                className="ext-float-btn"
                                onClick={handleDebuggerToggleMax}
                                aria-label={debuggerMaximized ? '还原' : '最大化'}
                                title={debuggerMaximized ? '还原' : '最大化'}
                            >{debuggerMaximized ? '❐' : '□'}</button>
                            <button
                                type="button"
                                className="ext-float-btn ext-float-btn-close"
                                onClick={handleCloseDebugger}
                                aria-label="关闭"
                                title="关闭"
                            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                        </div>
                    </div>
                    <div className="ext-float-body">
                        <DebuggerPanel code={exportableCode} />
                    </div>
                </div>
                </React.Fragment>
            )}

            {/* 项目数据分析面板（悬浮框，可拖拽/拉伸） */}
            {showStatsPanel && (
                <React.Fragment>
                {/* 自由拉伸层（8 方向手柄，常驻显示） */}
                {!statsMinimized && !statsMaximized && (
                <div className="ext-float-resize-layer" ref={statsResizeLayerRef}>
                    {['n','s','e','w','ne','nw','se','sw'].map(dir => (
                        <div key={dir} className={`ext-float-resize-handle ext-fz-${dir}`} onMouseDown={handleStatsResizeDown(dir)} />
                    ))}
                </div>
                )}
                <div
                    ref={statsPanelRef}
                    className={`ext-float-panel ext-stats-panel${statsMinimized ? ' ext-float-minimized' : ''}${statsMaximized ? ' maximized' : ''}`}
                    style={{left: statsFloatBounds.x, top: statsFloatBounds.y, width: statsFloatBounds.w, height: statsFloatBounds.h, display: statsMinimized ? 'none' : '', zIndex: getZIndex('stats')}}
                    onMouseDown={() => bringToFront('stats')}
                >
                    <div className="ext-float-header" onMouseDown={handleStatsHeaderMouseDown}>
                        <span className="ext-float-title">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2" style={{verticalAlign:'middle',marginRight:'6px'}}>
                                <path d="M21.21 15.89A10 10 0 118 2.83"/>
                                <path d="M22 12A10 10 0 0012 2v10z"/>
                            </svg>
                            项目数据分析
                        </span>
                        <div className="ext-float-btns">
                            <button className="ext-float-btn" onClick={handleStatsToggleMin} title={statsMinimized ? '还原' : '最小化'}>−</button>
                            <button className="ext-float-btn" onClick={handleStatsToggleMax} title={statsMaximized ? '还原' : '最大化'}>{statsMaximized ? '❐' : '□'}</button>
                            <button className="ext-float-btn ext-float-btn-close" onClick={() => setShowStatsPanel(false)} title="关闭">×</button>
                        </div>
                    </div>
                    <div className="ext-stats-body">
                        {/* 复杂度评分 */}
                        <div style={{background:'#e8f0fe',border:'1px solid #c5d8f7',borderRadius:8,padding:'12px 14px',marginBottom:14,display:'flex',alignItems:'center',gap:14}}>
                            <div style={{fontSize:32,fontWeight:800,color:'#1a73e8',lineHeight:1}}>{projectStats.complexityScore}<span style={{fontSize:14,fontWeight:400,color:'#888',marginLeft:2}}>/100</span></div>
                            <div style={{flex:1}}>
                                <div style={{fontSize:14,fontWeight:600,color:'#333',marginBottom:2}}>复杂度：{projectStats.complexityLevel}</div>
                                <div style={{fontSize:12,color:'#666'}}>{projectStats.blockCount} 个积木，{projectStats.lineCount} 行代码</div>
                            </div>
                        </div>

                        {/* 概览 */}
                        <div className="rtc-section-title">概览</div>
                        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
                            {[
                                [projectStats.blockCount,'积木总数','#4C97FF'],
                                [projectStats.hatCount,'帽积木','#FF6680'],
                                [projectStats.cmdCount,'命令积木','#4C97FF'],
                                [projectStats.reporterCount,'报告积木','#9966FF'],
                                [projectStats.boolCount,'布尔积木','#FF8C1A']
                            ].filter(v=>v[0]>0).map(([val,label,color])=>(
                                <div key={label} style={{background:'#f8f9fa',border:'1px solid #e9ecef',borderRadius:8,padding:'10px 12px'}}>
                                    <div style={{fontSize:20,fontWeight:700,color:'#333'}}>{val}</div>
                                    <div style={{fontSize:11,color:'#777',marginTop:2}}>{label}</div>
                                </div>
                            ))}
                        </div>

                        {/* 项目数据 */}
                        <div className="rtc-section-title">项目数据</div>
                        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
                            <div style={{background:'#f8f9fa',border:'1px solid #e9ecef',borderRadius:8,padding:'10px 12px'}}>
                                <div style={{fontSize:20,fontWeight:700,color:'#333'}}>{projectStats.lineCount}</div>
                                <div style={{fontSize:11,color:'#777',marginTop:2}}>代码行数</div>
                            </div>
                            <div style={{background:'#f8f9fa',border:'1px solid #e9ecef',borderRadius:8,padding:'10px 12px'}}>
                                <div style={{fontSize:20,fontWeight:700,color:'#333'}}>{formatBytes(projectStats.codeSize)}</div>
                                <div style={{fontSize:11,color:'#777',marginTop:2}}>核心代码</div>
                            </div>
                            <div style={{background:'#f8f9fa',border:'1px solid #e9ecef',borderRadius:8,padding:'10px 12px'}}>
                                <div style={{fontSize:20,fontWeight:700,color:'#333'}}>{formatBytes(projectStats.fullSize)}</div>
                                <div style={{fontSize:11,color:'#777',marginTop:2}}>导出大小</div>
                            </div>
                        </div>

                        {/* 建议 */}
                        <div className="rtc-section-title" style={{marginTop:10}}>建议</div>
                        <div style={{background:'#fffbe6',border:'1px solid #f5e6a3',borderRadius:6,padding:'10px 14px',fontSize:12,color:'#856404'}}>
                            {projectStats.blockCount === 0 ? '还没有添加积木。点击左侧「制作积木」开始创建。'
                             : projectStats.complexityScore < 15 ? '项目复杂度较低，继续添加更多积木和代码来丰富功能。'
                             : projectStats.complexityScore > 78 ? '项目较复杂，建议拆分为多个扩展以保持可维护性。'
                             : '项目结构良好，复杂度在合理范围内。'}
                        </div>
                    </div>
                </div>
                </React.Fragment>
            )}

            </div>
        );
    }
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function wrapAsExtension(extInfo, generatedCode, customBlocks) {
    const esc = (s) => String(s || '').replace(/'/g, "\\'");
    const headerLines = [
        ' * ' + extInfo.name,
        ' * Extension ID: ' + extInfo.id,
        extInfo.description ? ' * Description: ' + extInfo.description : null,
        extInfo.author ? ' * Author: ' + extInfo.author : null,
        extInfo.docsUrl ? ' * Docs: ' + extInfo.docsUrl : null,
        ' * License: ' + (extInfo.license || 'MPL-2.0'),
        ' * Blocks: ' + (Array.isArray(customBlocks) ? customBlocks.length : 0),
        ' * Generated by TurboWarp Extension Editor'
    ].filter(Boolean).join('\n');

    // Build block entries from customBlocks metadata.
    // Each block's `text` is reconstructed from its parts (text + input fragments).
    const blocks = (Array.isArray(customBlocks) ? customBlocks : []).map((b) => {
        const parts = Array.isArray(b.parts) ? b.parts : [];
        // TurboWarp text 语法：命名参数用 [NAME]（%s/%n 是 Blockly 语法，
        // TurboWarp 不解析，会原样显示成 "%s"）。arguments 必须与 [NAME]
        // 一一对应，否则 TurboWarp 静默丢弃该参数。
        const text = parts
            .map(p => p.kind === 'text' ? p.value : `[${p.name}]`)
            .join('');
        const filter = [];
        if (b.filterSprite) filter.push('TARGET_SPRITE');
        if (b.filterStage) filter.push('TARGET_STAGE');
        // 从 parts 构建 arguments（TurboWarp 的 ArgumentType 字符串形式）
        const argumentsDef = {};
        parts.forEach(p => {
            if (!p || p.kind !== 'input' || !p.name) return;
            argumentsDef[p.name] = {
                type: p.inputType === 'Number' ? 'number' : 'string',
                defaultValue: p.inputType === 'Number' ? 0 : ''
            };
        });
        const entry = {
            // CRITICAL: this opcode must EXACTLY match the method name the
            // generator emits. The generator uses `_opcode` which is
            // `(blockId || 'block').replace(/[^a-zA-Z0-9]/g, '_')` — so the
            // registered opcode must be the same transform of b.id. If they
            // differ (e.g. appending the block name), TurboWarp renders the
            // block but calling it fails silently ("no reaction").
            opcode: (b.id || 'block').replace(/[^a-zA-Z0-9]/g, '_'),
            // CRITICAL: TurboWarp parses text with `[NAME]` as a reference
            // to arguments.NAME. If no matching argument exists the bracket
            // is silently dropped, leaving a blank block (visible as a red
            // rectangle with no text). Wrap names in `[]` ONLY when an
            // argument is actually defined.
            text: text || (b.name || 'block'),
            blockType: b.blockType || 'command',
            arguments: argumentsDef
        };
        // 积木颜色：与预览 / 工作区共用 resolveBlockColour（自定义色 > 扩展 color1），
        // 并且**无条件**写出 colour 与 color1/color2/color3。
        // TurboWarp 的 scratch-vm 在 _convertBlockForScratchBlocks 中读取
        // blockInfo.color1（块级覆盖），缺省时退回扩展 color1。显式写出可保证
        // 「预览所见 = 导出后所见」，不会再出现预览/导出颜色不一致。
        // color2/color3 由 color1 变暗派生。
        const blockColour = resolveBlockColour(b, extInfo.color1);
        entry.colour = blockColour;
        entry.color1 = blockColour;
        entry.color2 = darkenHex(blockColour, 0.85);
        entry.color3 = darkenHex(blockColour, 0.7);
        if (b.isTerminal) entry.isTerminal = true;
        // isAsync：用户勾选，或生成的实现方法体含 await（block_define 会为
        // 含 await 的方法自动加 async 前缀并输出 "// isAsync: true" 注释）。
        // TurboWarp 对 isAsync 块会 await 方法返回值；漏标则异步块静默失效。
        const opcode = (b.id || 'block').replace(/[^a-zA-Z0-9]/g, '_');
        if (b.isAsync || new RegExp('async\\s+' + opcode + '\\s*\\(args').test(generatedCode)) {
            entry.isAsync = true;
        }
        if (b.attachAllThreads) entry.shouldRestartExistingThreads = true;
        if (filter.length) entry.filterTargets = filter;
        if (b.icon) entry.hideFromPalette = false;
        return entry;
    });

    const blocksJson = JSON.stringify(blocks, null, 4)
        .split('\n')
        .map(l => '                ' + l)
        .join('\n');

    const metaFields = [
        "                id: '" + esc(extInfo.id) + "',",
        "                name: '" + esc(extInfo.name) + "',",
        "                color1: '" + extInfo.color1 + "',",
        "                color2: '" + extInfo.color2 + "',",
        "                color3: '" + extInfo.color3 + "',",
        extInfo.description ? "                description: '" + esc(extInfo.description) + "'," : null,
        extInfo.author ? "                author: '" + esc(extInfo.author) + "'," : null,
        extInfo.docsUrl ? "                docsURL: '" + esc(extInfo.docsUrl) + "'," : null,
        extInfo.license ? "                license: '" + esc(extInfo.license) + "'," : null,
        '                blocks: ' + blocksJson
    ].filter(Boolean).join('\n');

    const className = extInfo.id
        .split(/[^a-zA-Z0-9]/)
        .filter(Boolean)
        .map(capitalize)
        .join('') || 'MyExtension';

    return `/**\n${headerLines}\n */\n\n` +
`(function(Scratch) {\n` +
`    'use strict';\n\n` +
FORGEXT_RUNTIME.split('\n').map(l => '    ' + l).join('\n') + '\n\n' +
`    class ${className} {\n` +
`        getInfo() {\n` +
`            return {\n` +
`${metaFields}\n` +
`            };\n` +
`        }\n\n` +
`${withUtilInjection(generatedCode).split('\n').map(l => '        ' + l).join('\n')}\n` +
`    }\n\n` +
`    Scratch.extensions.register(new ${className}());\n` +
`})(Scratch);\n`;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// 积木颜色的唯一真源：自定义颜色 > 扩展主题色（getInfo().color1）。
// TurboWarp 渲染扩展积木时，未显式声明颜色的积木会继承扩展的 color1；
// 工作区 / 预览 / 导出代码必须共用本函数，否则三处颜色会不一致
// （曾出现：预览按积木类型上色，导出后全部变成扩展主题色）。
function resolveBlockColour(cb, fallbackColour) {
    const own = cb && typeof cb.colour === 'string' ? cb.colour.trim() : '';
    if (/^#[0-9a-fA-F]{6}$/.test(own)) return own;
    const fallback = typeof fallbackColour === 'string' ? fallbackColour.trim() : '';
    if (/^#[0-9a-fA-F]{6}$/.test(fallback)) return fallback;
    return DEFAULT_EXTENSION_INFO.color1;
}

// 从 hex 颜色按比例变暗，派生 color2/color3（'#RRGGBB' -> '#RRGGBB'）
function darkenHex(hex, factor) {
    const h = String(hex || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return hex;
    const n = (v) => {
        const x = Math.max(0, Math.min(255, Math.round(v * factor)));
        return x.toString(16).padStart(2, '0');
    };
    return '#' + n(parseInt(h.slice(1, 3), 16)) + n(parseInt(h.slice(3, 5), 16)) + n(parseInt(h.slice(5, 7), 16));
}

/**
 * Render one customBlock as a real Scratch block inside `ws` (a hidden
 * workspace) and return the wrapped SVG string. Module-level so both the
 * modal preview and the builder-panel preview can reuse it.
 */
function renderCustomBlockToSvg(ws, cb, idx, fallbackColour) {
    if (!ws || !cb) return '';
    const B = window._extBuilderBlockly || window.Blockly;
    if (!B || !B.Blocks) return '';
    const name = cb.name || ('我的积木 ' + ((idx || 0) + 1));
    const fields = Array.isArray(cb.fields) ? cb.fields : [];

    // Build message template + args from the fields
    let message0 = '%1';
    const args0 = [{type: 'field_label', text: name, name: 'NAME'}];
    fields.forEach(function (f, fi) {
        if (!f) return;
        const ftype = f.kind || 'text';
        const textIdx = (fi * 2) + 2;
        const inputIdx = (fi * 2) + 3;
        if (ftype === 'label') {
            args0.push({type: 'field_label', text: f.text || '', name: 'TXT' + fi});
            message0 += ' %' + textIdx;
        } else {
            args0.push({type: 'field_label', text: f.text || '', name: 'TXT' + fi});
            if (ftype === 'number') {
                args0.push({type: 'field_number', value: Number(f.default) || 0, name: 'FLD' + fi, precision: 1});
            } else if (ftype === 'boolean') {
                args0.push({type: 'field_dropdown', options: [['是','true'],['否','false']], name: 'FLD' + fi});
            } else {
                args0.push({type: 'field_input', text: f.default || f.text || '', name: 'FLD' + fi});
            }
            message0 += ' %' + textIdx + ' %' + inputIdx;
        }
    });

    // Choose the scratch block shape by blockType.
    let shapeDef = {id: 'C'};
    if (cb.blockType === 'reporter') shapeDef = {output: 'Number'};
    else if (cb.blockType === 'Boolean') shapeDef = {output: 'Boolean'};
    else if (cb.blockType === 'hat') shapeDef = {id: 'HAT'};
    // 颜色与导出代码共用同一解析规则（自定义色 > 扩展 color1），
    // 保证「预览所见 = 导出后 TurboWarp 里的实际渲染」。
    // 注意：不要再按积木类型给不同默认色，TurboWarp 里同扩展的积木默认同色。
    shapeDef.colour = resolveBlockColour(cb, fallbackColour);

    const previewType = (cb.id || ('b' + idx)) + '__preview';
    // Force re-registration so shape / fields changes are reflected live.
    if (B.Blocks[previewType]) B.Blocks[previewType] = null;
    B.Blocks[previewType] = {
        init: function () {
            const opts = JSON.parse(JSON.stringify({
                message0: message0,
                args0: args0
            }));
            opts.colour = shapeDef.colour;
            if (shapeDef.output !== undefined) opts.output = shapeDef.output;
            opts['id'] = shapeDef.id || 'C';
            if (shapeDef.id === 'HAT') {
                delete opts.previousStatement;
                // shape_hat extension will create the nextConnection via
                // setNextStatement(true). Don't pre-set it to null or
                // setNextStatement(false) — that would remove the
                // connection and break the top-hat shape.
                opts.extensions = ['shape_hat'];
            } else if (shapeDef.output !== undefined) {
                delete opts.previousStatement;
                delete opts.nextStatement;
            } else {
                opts.previousStatement = null;
                opts.nextStatement = null;
            }
            this.jsonInit(opts);
            if (shapeDef.id === 'HAT' && this.setInputsInline) {
                this.setInputsInline(true);
            }
            if (this.outputConnection) {
                let s = null;
                if (shapeDef.output === 'Boolean') s = 1;
                else if (shapeDef.output === 'Number' || shapeDef.output === 'String') s = 2;
                if (s !== null && this.setOutputShape) this.setOutputShape(s);
            }
        }
    };

    try {
        const b = ws.newBlock(previewType);
        b.initSvg();
        b.moveBy(8, 8);
        b.render();
        const draggable = b.getSvgRoot().querySelector('.blocklyDraggable') || b.getSvgRoot();
        let innerXml = draggable.outerHTML;
        innerXml = innerXml.replace(/ transform="translate\([^)]*\)"/, '');
        let w = 100, h = 40;
        try {
            const bbox = draggable.getBBox();
            w = bbox.width;
            h = bbox.height;
        } catch (e) { /* bbox may fail on hidden svg */ }
        // For hat blocks, the top-hat curve extends into negative y (the
        // START_HAT_PATH control points are y=-22) but getBBox ignores it,
        // so the visible SVG box clips the curve. Wrap the inner SVG with
        // a viewBox that includes the negative-y range and shift the
        // group down by the hat height so the curve becomes visible.
        let hatPad = 0;
        if (shapeDef.id === 'HAT') {
            hatPad = 22;
            innerXml = innerXml.replace(
                /<g class="blocklyDraggable"([^>]*)>/,
                '<g class="blocklyDraggable"$1 transform="translate(0,' + hatPad + ')">'
            );
            // bump the path inside so its origin moves down too
            innerXml = innerXml.replace(
                /<path class="blocklyPath"/,
                '<path transform="translate(0,' + hatPad + ')" class="blocklyPath"'
            );
            // Adjust the left/top notch indicators if present
            innerXml = innerXml.replace(
                /<g class="blocklyResizeSE"/,
                '<g transform="translate(0,' + hatPad + ')" class="blocklyResizeSE"'
            );
        }
        const wrapped =
            '<svg width="' + Math.ceil(w) + '" height="' + Math.ceil(h + hatPad) +
            '" xmlns="http://www.w3.org/2000/svg" class="blockly-svg">' +
            innerXml + '</svg>';
        b.dispose(false);
        return wrapped;
    } catch (e) {
        return '';
    }
}

export default ExtensionBuilder;