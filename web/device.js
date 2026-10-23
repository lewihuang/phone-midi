// MIDI Deck — 手机 / 平板判定与入口路由
//
// 为什么需要它：同一个网址，手机该看到"三个模块 + 一页 8 格"，平板该看到"48 格铺一页 +
// X/Y + 没有推子"。这件事必须由**页面自己**判：Bridge 只能看到 HTTP 请求，而 iPadOS 13 起
// Safari 的 UA 自称 Macintosh，服务器端按 UA 判平板必然把 iPad 认成电脑。
//
// 判据是**屏幕短边**（`min(innerWidth, innerHeight)`）而不是 UA：
//   * 手机（含横过来、含大屏直板机）短边 ≤ ~430 → 手机；
//   * iPad mini 竖屏 768、iPad 横屏 768、安卓平板常见 800/1200 → 平板。
// 门槛取 640：手机上不会命中，最小的平板（iPad mini 竖屏 768）已经命中。
//
// 退路（页面底部都有"平板版 / 手机版"切换）：`?device=tablet` / `?device=phone` 会被记住，
// `?device=auto` 清掉记忆、回到按屏幕自动判。iPad 分屏（窗口短边可能 < 640）就靠这个。
(() => {
  'use strict';

  const KEY = 'pm.device';
  const TABLET_MIN_SHORT_SIDE = 640;   // 见文件头：640 是"手机上不可能、平板上一眼命中"的那条线

  function readPref() {
    try {
      const v = localStorage.getItem(KEY);
      return (v === 'phone' || v === 'tablet') ? v : null;
    } catch (_) { return null; }       // 隐私模式 / 禁用存储：退回自动判断
  }

  function writePref(v) {
    try {
      if (v === 'phone' || v === 'tablet') localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (_) { /* 存不住不影响这一次的判断 */ }
  }

  /** `?device=…` 优先；它一旦出现就记下来，下一页继续按用户选的走。 */
  function consumeQuery() {
    let q = null;
    try { q = new URLSearchParams(location.search || '').get('device'); } catch (_) { return; }
    if (q === 'phone' || q === 'tablet') { writePref(q); return; }
    if (q === 'auto') writePref(null);
  }

  function detectedTablet() {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    if (!w || !h) return false;        // 取不到视口尺寸时按手机处理：宁可少功能，不要给一格 48 的布局
    return Math.min(w, h) >= TABLET_MIN_SHORT_SIDE;
  }

  consumeQuery();
  const pref = readPref();

  /**
   * 当前该按哪一档走。`pref` 是用户显式选的，优先于屏幕尺寸；
   * 没有 `pref` 时才看短边。
   */
  function isTablet() {
    return pref ? pref === 'tablet' : detectedTablet();
  }

  function go(url) {
    // replace 而不是 assign：别让"平板打开 / 被送去 /tablet.html"在后退栈里留一条死循环。
    try {
      if (typeof location.replace === 'function') { location.replace(url); return; }
    } catch (_) { /* 个别内嵌浏览器禁用 replace，退回 assign */ }
    location.href = url;
  }

  /**
   * 每个宿主页在脚本最前面调一次（页面自己写在 `<html data-route="…">` 上，本文件会自动调用）：
   *   `route('home')`   首页：平板 → /tablet.html
   *   `route('phone')`  手机专用页（推子 / 面板 / X/Y）：平板 → /tablet.html（平板没有推子）
   *   `route('tablet')` 平板页：手机 → /pad.html
   * 已经在对的页面上时**什么都不做**，调用方照常继续初始化。
   */
  function route(kind) {
    if (kind === 'tablet') {
      if (!isTablet()) go('/pad.html');
      return;
    }
    if (isTablet()) go('/tablet.html');
  }

  window.PhoneMidiDevice = {
    TABLET_MIN_SHORT_SIDE,
    isTablet,
    detectedTablet,
    preference: () => pref,
    setPreference: writePref,
    route,
  };

  // 页面用 `<html data-route="home|phone|tablet">` 声明自己是谁，这里自动走一次路由。
  // 放在 <head> 的同步脚本里，所以平板打开手机页时是在**首次绘制之前**被送走的，不会闪一下。
  const kind = (document.documentElement && document.documentElement.dataset)
    ? document.documentElement.dataset.route : '';
  if (kind === 'home' || kind === 'phone' || kind === 'tablet') route(kind);
})();
