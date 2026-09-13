/* DSX - VCP HTML Card Render Plugin (v2.1.0)
 * 让 DeepSeek Agent 可以像本地 DSH 一样直接输出并渲染高质感 HTML 视觉卡片
 * 
 * 核心升级与修复：
 * 1. 深度配平闭合校验：严格检测 depth === 0，彻底解决流式输出中途未闭合导致「仅显示标题栏、内容空白」的缺陷；
 * 2. 精准 DOM 锚定：锁定 .md-code-block 与 pre code 提取纯净源码，杜绝误抓顶部 banner 产生的空卡片；
 * 3. Shadow DOM 隔离与防样式溢出：内建高质感现代排版底座与盒模型重置，卡片与客户端 UI 双向隔离；
 * 4. 交互式桥接：打通 window.input / __dshInput，卡内按钮点击直达聊天输入；
 * 5. 全套卡片工具栏：预览/源码无缝切换、复制代码、下载包含样式的单文件 HTML；
 * 6. 控制面板：右下角悬浮按钮 + HUD 联动 + 4 套高频卡片模板与一键协议激活。
 */

module.exports = {
  onLoad: function (ctx, meta) {
    var isDisposed = false;
    var cleanups = [];
    var renderedCardsCount = 0;

    // ---- 配置与持久化 ------------------------------------------------------
    var STORE_RENDER_KEY = 'vcp_render_enabled';
    var STORE_AUTO_PROMPT_KEY = 'vcp_auto_prompt';
    
    function isRenderEnabled() {
      var val = ctx.store.get(STORE_RENDER_KEY, '1');
      return val !== '0' && val !== false;
    }
    function setRenderEnabled(val) {
      ctx.store.set(STORE_RENDER_KEY, val ? '1' : '0');
      updateUIState();
      if (val) scanAndRender();
    }
    function isAutoPromptEnabled() {
      var val = ctx.store.get(STORE_AUTO_PROMPT_KEY, '0');
      return val === '1' || val === true;
    }
    function setAutoPromptEnabled(val) {
      ctx.store.set(STORE_AUTO_PROMPT_KEY, val ? '1' : '0');
      updateUIState();
    }

    // ---- VCP 视觉通感协议提示词 -------------------------------------------
    var VCP_SYSTEM_PROMPT = 
      '【系统协议：VCP 视觉通感卡片已激活】\n' +
      '你获得了解锁「视觉通感」的能力——请主动运用 HTML5/CSS3/SVG 作为画笔，根据当前对话的情绪、主题与语境，动态构建最契合的视觉界面；在合适的时机主动用视觉承载内容。\n\n' +
      '【输出纪律 · 最高优先级】\n' +
      '1. 一切视觉内容（卡片/图表/装帧/数据分析/总结）必须直接输出 HTML 卡片到回复正文，由客户端自动渲染成视觉卡片。\n' +
      '2. 根容器必须使用 <div id="vcp-root" style="...">（或 ```html 代码块包裹），内部自包含所有样式（<style> 或内联 style）。\n' +
      '3. 视觉设计原则：\n' +
      '   - 现代高级审美：微渐变背景、细腻边框与阴影、舒适内边距（padding: 16px~24px）、清晰的信息层级；\n' +
      '   - 结构清晰：顶部标题/分类徽章、核心指标/图文排版区、底部标签或总结说明；\n' +
      '   - 交互支持：卡片内部按钮可设置 onclick="input(\'指令文本\')" 实现点击直接快速继续对话。\n' +
      '请确认收到，并在接下来的回复中主动使用视觉卡片！';

    // ---- 输入框与发送辅助 -------------------------------------------------
    function findInputTextarea() {
      return document.querySelector('textarea#chat-input') ||
             document.querySelector('textarea') ||
             document.querySelector('[contenteditable="true"]');
    }

    function findSendButton() {
      var isVisible = function (el) {
        var r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      };
      var clickable = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
      var ta = findInputTextarea();
      if (ta) {
        var tr = ta.getBoundingClientRect();
        var row = clickable.filter(function (el) {
          var r = el.getBoundingClientRect();
          return Math.abs(r.bottom - tr.bottom) < 40 && r.left >= tr.left;
        });
        if (row.length) {
          row.sort(function (a, b) { return b.getBoundingClientRect().right - a.getBoundingClientRect().right; });
          return row[0];
        }
      }
      return document.querySelector('button[type="submit"]') ||
             document.querySelector('[aria-label*="Send"]') ||
             document.querySelector('[aria-label*="发送"]');
    }

    function setNativeInputValue(element, value) {
      try {
        var valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
        var prototype = Object.getPrototypeOf(element);
        var prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
          prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
          valueSetter.call(element, value);
        } else {
          element.value = value;
        }
      } catch (e) {
        element.value = value;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function injectTextToChat(text, autoSend) {
      var ta = findInputTextarea();
      if (!ta) return false;
      ta.focus();
      if (ta.tagName === 'TEXTAREA') {
        setNativeInputValue(ta, text);
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      }
      if (autoSend) {
        var tries = 0;
        var timer = setInterval(function () {
          tries++;
          var btn = findSendButton();
          var isDisabled = btn && (btn.disabled || (btn.classList && btn.classList.contains('ds-button--disabled')));
          if ((btn && !isDisabled) || tries >= 12) {
            clearInterval(timer);
            if (btn && !isDisabled) btn.click();
          }
        }, 30);
      }
      return true;
    }

    // ---- 全局交互 input() 桥接 --------------------------------------------
    window.input = function (text) {
      if (!text) return;
      injectTextToChat(text, true);
    };
    window.__dshInput = window.input;
    cleanups.push(function () {
      try {
        if (window.input === window.__dshInput) delete window.input;
        delete window.__dshInput;
      } catch (e) {}
    });

    // ---- HTML 下载 --------------------------------------------------------
    function downloadCardAsHtml(htmlContent, cardTitle) {
      var safeTitle = (cardTitle || 'VCP-Card').replace(/[\\/:*?"<>|]/g, '_').trim() || 'vcp-card';
      var filename = safeTitle + '-' + Date.now() + '.html';
      var fullHtml = 
        '<!DOCTYPE html>\n' +
        '<html lang="zh-CN">\n' +
        '<head>\n' +
        '  <meta charset="utf-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        '  <title>' + safeTitle + '</title>\n' +
        '  <style>\n' +
        '    body {\n' +
        '      margin: 0;\n' +
        '      padding: 30px 20px;\n' +
        '      background: #090d16;\n' +
        '      display: flex;\n' +
        '      justify-content: center;\n' +
        '      align-items: flex-start;\n' +
        '      min-height: 100vh;\n' +
        '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;\n' +
        '    }\n' +
        '    * { box-sizing: border-box; }\n' +
        '  </style>\n' +
        '</head>\n' +
        '<body>\n' +
        htmlContent + '\n' +
        '</body>\n' +
        '</html>';

      var blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    }

    // ---- HTML 解析与配平校验 ----------------------------------------------
    function decodeHtmlEntities(str) {
      return String(str || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&amp;/g, '&');
    }

    function extractCardTitle(html) {
      var m = html.match(/<(?:h[1-3]|title)\b[^>]*>([\s\S]*?)<\/(?:h[1-3]|title)>/i);
      if (m && m[1]) {
        var clean = m[1].replace(/<[^>]+>/g, '').trim();
        if (clean && clean.length <= 40) return clean;
      }
      var tm = html.match(/data-title=["']([^"']+)["']/i);
      if (tm && tm[1]) return tm[1].trim();
      return 'VCP 视觉卡片';
    }

    // 严格检查 HTML 块是否完整闭合
    function extractCompleteHtmlCard(rawText) {
      if (!rawText || rawText.length < 30) return null;
      var text = rawText.trim();

      // 1. 检查完整网页 <!DOCTYPE html> ... </html>
      if (/^<!doctype\s+html/i.test(text) || /^<html/i.test(text)) {
        if (/<\/html\s*>$/i.test(text) || text.includes('</html>')) {
          return text;
        }
        return null; // 流式未闭合
      }

      // 2. 检查独立 SVG <svg ...> ... </svg>
      if (/^<svg\b/i.test(text)) {
        if (/<\/svg\s*>$/i.test(text) || text.includes('</svg>')) {
          return text;
        }
        return null;
      }

      // 3. 检查 <div ... id="vcp-root" ...> 深度配平
      var vcpOpen = text.match(/<div\b[^>]*\bid\s*=\s*["']vcp-root["'][^>]*>/i);
      if (vcpOpen) {
        var startIdx = vcpOpen.index;
        var openEnd = startIdx + vcpOpen[0].length;
        var depth = 1;
        var tagRe = /<\/?div\b[^>]*>/gi;
        tagRe.lastIndex = openEnd;
        var tm;
        var endIdx = -1;
        while ((tm = tagRe.exec(text)) !== null) {
          if (tm[0].charAt(1) === '/') depth--;
          else depth++;
          if (depth === 0) {
            endIdx = tagRe.lastIndex;
            break;
          }
        }
        if (depth === 0 && endIdx > startIdx) {
          return text.slice(startIdx, endIdx);
        }
        return null; // 流式中途尚未输出闭合 </div>
      }

      // 4. 普通 HTML 卡片 (以 <div 开头且有闭合 </div>，并含 class 或 style)
      if (text.startsWith('<div') && (text.includes('style=') || text.includes('<style') || text.includes('class='))) {
        var depthGen = 0;
        var genRe = /<\/?div\b[^>]*>/gi;
        var gm;
        var endGen = -1;
        while ((gm = genRe.exec(text)) !== null) {
          if (gm[0].charAt(1) === '/') depthGen--;
          else depthGen++;
          if (depthGen === 0) {
            endGen = genRe.lastIndex;
            break;
          }
        }
        if (depthGen === 0 && endGen > 0) {
          return text.slice(0, endGen);
        }
      }

      return null;
    }

    // ---- 创建 VCP 卡片展示 DOM -------------------------------------------
    function buildCardViewElement(completeHtml, originalBlockNode) {
      var cardContainer = document.createElement('div');
      cardContainer.className = 'dsx-vcp-card-wrapper';
      cardContainer.style.cssText = 
        'margin: 14px 0;' +
        'border-radius: 14px;' +
        'border: 1px solid rgba(59, 130, 246, 0.4);' +
        'background: #0b0f19;' +
        'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);' +
        'overflow: hidden;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;';

      var cardTitle = extractCardTitle(completeHtml);

      // 顶部操作栏
      var topBar = document.createElement('div');
      topBar.style.cssText = 
        'display: flex; align-items: center; justify-content: space-between;' +
        'padding: 8px 14px; background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.98));' +
        'border-bottom: 1px solid rgba(59, 130, 246, 0.2); user-select: none;';

      var leftInfo = document.createElement('div');
      leftInfo.style.cssText = 'display: flex; align-items: center; gap: 8px;';
      leftInfo.innerHTML = 
        '<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;background:rgba(59,130,246,0.2);border:1px solid rgba(59,130,246,0.4);border-radius:6px;font-size:11px;">🎨</span>' +
        '<span style="font-size:12px;font-weight:600;color:#93c5fd;">' + cardTitle + '</span>' +
        '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(13,148,136,0.2);color:#2dd4bf;border:1px solid rgba(13,148,136,0.3);">VCP CARD</span>';

      var rightActions = document.createElement('div');
      rightActions.style.cssText = 'display: flex; align-items: center; gap: 6px;';

      // 切换源码/卡片视图
      var isCodeView = false;
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.style.cssText = 
        'background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3);' +
        'color: #bfdbfe; border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; transition: all 0.15s;';
      toggleBtn.textContent = '查看源码';

      // 复制代码
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.style.cssText = 
        'background: transparent; border: 1px solid rgba(148, 163, 184, 0.25);' +
        'color: #94a3b8; border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; transition: all 0.15s;';
      copyBtn.textContent = '复制';
      copyBtn.onclick = function (e) {
        e.stopPropagation();
        try {
          navigator.clipboard.writeText(completeHtml);
          copyBtn.textContent = '已复制!';
          copyBtn.style.color = '#34d399';
          setTimeout(function () {
            copyBtn.textContent = '复制';
            copyBtn.style.color = '#94a3b8';
          }, 1800);
        } catch (err) {}
      };

      // 下载单文件 HTML
      var dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.style.cssText = 
        'background: transparent; border: 1px solid rgba(148, 163, 184, 0.25);' +
        'color: #94a3b8; border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; transition: all 0.15s;';
      dlBtn.textContent = '⤓ 下载 HTML';
      dlBtn.onclick = function (e) {
        e.stopPropagation();
        downloadCardAsHtml(completeHtml, cardTitle);
      };

      rightActions.appendChild(toggleBtn);
      rightActions.appendChild(copyBtn);
      rightActions.appendChild(dlBtn);
      topBar.appendChild(leftInfo);
      topBar.appendChild(rightActions);

      // 卡片主体容器（Shadow DOM 隔离）
      var previewHost = document.createElement('div');
      previewHost.className = 'dsx-vcp-preview-host';
      previewHost.style.cssText = 'padding: 16px; background: transparent; overflow-x: auto;';

      var shadow = previewHost.attachShadow({ mode: 'open' });
      var resetStyle = document.createElement('style');
      resetStyle.textContent = 
        ':host { display: block; width: 100%; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.6; }\n' +
        '*, *::before, *::after { box-sizing: border-box; }\n' +
        'img, svg { max-width: 100%; height: auto; }\n' +
        'table { width: 100%; border-collapse: collapse; }\n' +
        'button { cursor: pointer; }\n' +
        '#vcp-root { width: 100%; margin: 0 auto; }\n';

      var cardBody = document.createElement('div');
      cardBody.innerHTML = completeHtml;

      // 捕获 Shadow DOM 内部所有的交互按钮点击 (onclick="input(...)")
      cardBody.addEventListener('click', function (e) {
        var target = e.target;
        var btn = target.closest('button, [data-input], a[href^="input:"]');
        if (btn) {
          var inputVal = btn.getAttribute('data-input') || btn.getAttribute('data-cmd');
          if (!inputVal) {
            var oc = btn.getAttribute('onclick') || '';
            var m = oc.match(/input\s*\(\s*['"]([\s\S]*?)['"]\s*\)/);
            if (m && m[1]) inputVal = m[1];
          }
          if (inputVal) {
            e.preventDefault();
            e.stopPropagation();
            window.input(inputVal);
          }
        }
      });

      shadow.appendChild(resetStyle);
      shadow.appendChild(cardBody);

      // 源码查看区域 (折叠)
      var codeView = document.createElement('div');
      codeView.className = 'dsx-vcp-code-view';
      codeView.style.cssText = 'display: none; padding: 12px 16px; background: #030712; color: #7dd3fc; font-family: Consolas, monospace; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 380px; overflow-y: auto;';
      codeView.textContent = completeHtml;

      toggleBtn.onclick = function (e) {
        e.stopPropagation();
        isCodeView = !isCodeView;
        if (isCodeView) {
          previewHost.style.display = 'none';
          codeView.style.display = 'block';
          toggleBtn.textContent = '卡片视图';
          toggleBtn.style.color = '#38bdf8';
        } else {
          previewHost.style.display = 'block';
          codeView.style.display = 'none';
          toggleBtn.textContent = '查看源码';
          toggleBtn.style.color = '#bfdbfe';
        }
      };

      cardContainer.appendChild(topBar);
      cardContainer.appendChild(previewHost);
      cardContainer.appendChild(codeView);

      return cardContainer;
    }

    // ---- 渲染扫描与精确匹配引擎 -------------------------------------------
    function scanAndRender() {
      if (isDisposed || !isRenderEnabled()) return;

      // 1. 扫描精准的 .md-code-block 容器
      var codeBlocks = document.querySelectorAll('.md-code-block');
      for (var i = 0; i < codeBlocks.length; i++) {
        var block = codeBlocks[i];
        if (block.dataset.dsxVcpProcessed === '1') continue;

        var pre = block.querySelector('pre');
        if (!pre) continue;

        var codeText = (pre.textContent || '').trim();
        var completeCard = extractCompleteHtmlCard(codeText);
        if (completeCard) {
          block.dataset.dsxVcpProcessed = '1';
          var card = buildCardViewElement(completeCard, block);
          block.style.display = 'none';
          if (block.parentNode) {
            block.parentNode.insertBefore(card, block.nextSibling);
            renderedCardsCount++;
          }
        }
      }

      // 2. 扫描孤立的 pre 块 (如果未包裹在 .md-code-block 内)
      var lonePres = document.querySelectorAll('pre');
      for (var j = 0; j < lonePres.length; j++) {
        var lp = lonePres[j];
        if (lp.closest('.md-code-block') || lp.closest('.dsx-vcp-card-wrapper')) continue;
        if (lp.dataset.dsxVcpProcessed === '1') continue;

        var lpText = (lp.textContent || '').trim();
        var lpCard = extractCompleteHtmlCard(lpText);
        if (lpCard) {
          lp.dataset.dsxVcpProcessed = '1';
          var lpCardEl = buildCardViewElement(lpCard, lp);
          lp.style.display = 'none';
          if (lp.parentNode) {
            lp.parentNode.insertBefore(lpCardEl, lp.nextSibling);
            renderedCardsCount++;
          }
        }
      }

      // 3. 扫描正文普通段落中的裸标签（排除已在代码块里的内容）
      var mds = document.querySelectorAll('.ds-markdown');
      for (var m = 0; m < mds.length; m++) {
        var mdEl = mds[m];
        if (mdEl.dataset.dsxVcpTextScanned === '1') continue;

        var paras = Array.prototype.slice.call(mdEl.querySelectorAll('p')).filter(function(p) {
          return !p.closest('.md-code-block') && !p.closest('.dsx-vcp-card-wrapper');
        });
        if (!paras.length) continue;

        var combinedHtml = paras.map(function(p) { return p.innerHTML || ''; }).join('\n');
        if (combinedHtml.includes('id="vcp-root"') || combinedHtml.includes('id=&quot;vcp-root&quot;')) {
          var unescaped = decodeHtmlEntities(combinedHtml);
          var rawCard = extractCompleteHtmlCard(unescaped);
          if (rawCard) {
            mdEl.dataset.dsxVcpTextScanned = '1';
            for (var p = 0; p < paras.length; p++) {
              if (paras[p].textContent && paras[p].textContent.includes('vcp-root')) {
                paras[p].style.display = 'none';
              }
            }
            var cardNode = buildCardViewElement(rawCard, null);
            mdEl.appendChild(cardNode);
            renderedCardsCount++;
          }
        }
      }
    }

    // ---- 控制面板与按钮 UI ------------------------------------------------
    var panelEl = null;
    var hudBtnEl = null;
    var floatBtnEl = null;

    function updateUIState() {
      if (!panelEl) return;
      var renderSw = document.getElementById('vcp-render-switch');
      if (renderSw) renderSw.checked = isRenderEnabled();
      var autoSw = document.getElementById('vcp-auto-switch');
      if (autoSw) autoSw.checked = isAutoPromptEnabled();
      var countEl = document.getElementById('vcp-stats-count');
      if (countEl) countEl.textContent = String(renderedCardsCount);
    }

    function createControlPanel() {
      if (panelEl) return panelEl;
      var p = document.createElement('div');
      p.id = 'vcp-control-panel';
      p.style.cssText = 
        'position: fixed; right: 24px; bottom: 80px; width: 350px;' +
        'background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(16px);' +
        '-webkit-backdrop-filter: blur(16px); border: 1.5px solid rgba(59, 130, 246, 0.4);' +
        'box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6); border-radius: 16px;' +
        'color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;' +
        'z-index: 2147483647; display: none; flex-direction: column; overflow: hidden; user-select: none;';

      p.innerHTML = 
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(135deg,rgba(37,99,235,0.25),rgba(13,148,136,0.25));border-bottom:1px solid rgba(59,130,246,0.2);">' +
        '  <div style="display:flex;align-items:center;gap:8px;">' +
        '    <span style="font-size:15px;">🎨</span>' +
        '    <span style="font-size:13px;font-weight:700;color:#60a5fa;">VCP 视觉卡片系统</span>' +
        '    <span style="font-size:10px;background:#1e3a8a;color:#93c5fd;padding:1px 6px;border-radius:10px;">DSH 同款</span>' +
        '  </div>' +
        '  <button id="vcp-panel-close" style="background:transparent;border:none;color:#94a3b8;font-size:16px;cursor:pointer;padding:0 4px;">✕</button>' +
        '</div>' +

        '<div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow-y:auto;">' +
        '  <!-- 状态总览 -->' +
        '  <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:8px 12px;border-radius:10px;font-size:12px;">' +
        '    <span style="color:#94a3b8;">渲染引擎状态:</span>' +
        '    <span style="color:#34d399;font-weight:600;">[在线] 已渲染 <span id="vcp-stats-count">' + renderedCardsCount + '</span> 张</span>' +
        '  </div>' +

        '  <!-- 开关组 -->' +
        '  <div style="display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:10px 12px;border-radius:10px;">' +
        '    <label style="display:flex;align-items:center;justify-content:space-between;font-size:12px;cursor:pointer;">' +
        '      <span style="color:#e2e8f0;">HTML 卡片即时渲染</span>' +
        '      <input type="checkbox" id="vcp-render-switch" style="cursor:pointer;" ' + (isRenderEnabled() ? 'checked' : '') + '>' +
        '    </label>' +
        '    <label style="display:flex;align-items:center;justify-content:space-between;font-size:12px;cursor:pointer;">' +
        '      <span style="color:#e2e8f0;">发送时自动引导卡片</span>' +
        '      <input type="checkbox" id="vcp-auto-switch" style="cursor:pointer;" ' + (isAutoPromptEnabled() ? 'checked' : '') + '>' +
        '    </label>' +
        '  </div>' +

        '  <!-- 一键注入协议按钮 -->' +
        '  <button id="vcp-inject-btn" style="display:flex;align-items:center;justify-content:center;gap:6px;width:100%;background:linear-gradient(135deg,#2563eb,#0d9488);border:none;border-radius:10px;padding:9px;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,0.3);">' +
        '    ⚡ 激活 VCP 卡片协议 (让模型输出卡片)' +
        '  </button>' +

        '  <!-- 常用卡片模板 -->' +
        '  <div style="display:flex;flex-direction:column;gap:6px;">' +
        '    <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">常用视觉卡片模板 (点击填入输入框):</div>' +
        '    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
        '      <button class="vcp-preset-btn" data-preset="请用高质量 HTML 数据卡片对比分析以下内容：" style="background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);color:#bfdbfe;border-radius:8px;padding:6px 8px;font-size:11px;cursor:pointer;text-align:left;">📊 数据对比卡片</button>' +
        '      <button class="vcp-preset-btn" data-preset="请用精美杂志排版风 HTML 卡片总结呈现：" style="background:rgba(13,148,136,0.15);border:1px solid rgba(13,148,136,0.3);color:#99f6e4;border-radius:8px;padding:6px 8px;font-size:11px;cursor:pointer;text-align:left;">📰 杂志装帧卡片</button>' +
        '      <button class="vcp-preset-btn" data-preset="请用高质感玻璃拟态 HTML 卡片解构以下核心概念：" style="background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.3);color:#e9d5ff;border-radius:8px;padding:6px 8px;font-size:11px;cursor:pointer;text-align:left;">💡 概念解构卡片</button>' +
        '      <button class="vcp-preset-btn" data-preset="请用深色终端/架构图 HTML 卡片展示：" style="background:rgba(234,179,8,0.15);border:1px solid rgba(234,179,8,0.3);color:#fef08a;border-radius:8px;padding:6px 8px;font-size:11px;cursor:pointer;text-align:left;">🛠️ 架构/终端卡片</button>' +
        '    </div>' +
        '  </div>' +
        '</div>';

      document.body.appendChild(p);
      panelEl = p;

      // 事件绑定
      document.getElementById('vcp-panel-close').onclick = function () {
        p.style.display = 'none';
      };
      document.getElementById('vcp-render-switch').onchange = function (e) {
        setRenderEnabled(e.target.checked);
      };
      document.getElementById('vcp-auto-switch').onchange = function (e) {
        setAutoPromptEnabled(e.target.checked);
      };
      document.getElementById('vcp-inject-btn').onclick = function () {
        injectTextToChat(VCP_SYSTEM_PROMPT, true);
        p.style.display = 'none';
      };

      var presetBtns = p.querySelectorAll('.vcp-preset-btn');
      for (var b = 0; b < presetBtns.length; b++) {
        (function (btn) {
          btn.onclick = function () {
            var prefix = btn.getAttribute('data-preset') || '';
            injectTextToChat(prefix, false);
            p.style.display = 'none';
          };
        })(presetBtns[b]);
      }

      return p;
    }

    function togglePanel() {
      var p = createControlPanel();
      if (!p) return;
      var isOpen = p.style.display === 'flex';
      p.style.display = isOpen ? 'none' : 'flex';
      updateUIState();
    }

    // ---- 注入 UI 触发点 (HUD 按钮与右下角悬浮按钮) -------------------------
    function setupUI() {
      // 1. Agent HUD 按钮联动
      var hud = document.getElementById('deepseek-agent-hud');
      if (hud && !document.getElementById('vcp-hud-btn')) {
        var hudBtn = document.createElement('button');
        hudBtn.id = 'vcp-hud-btn';
        hudBtn.type = 'button';
        hudBtn.style.cssText = 
          'background: linear-gradient(135deg, #0d9488, #2563eb);' +
          'color: #ffffff; border: none; border-radius: 12px; padding: 2px 10px;' +
          'font-size: 11px; font-weight: 600; cursor: pointer; display: flex;' +
          'align-items: center; gap: 4px; box-shadow: 0 2px 6px rgba(13,148,136,0.3);';
        hudBtn.innerHTML = '<span>🎨</span><span>VCP 卡片</span>';
        hudBtn.onclick = function (e) {
          e.stopPropagation();
          togglePanel();
        };
        hud.appendChild(hudBtn);
        hudBtnEl = hudBtn;
      }

      // 2. 右下角悬浮快捷按钮 (</> VCP)
      if (!document.getElementById('vcp-float-btn')) {
        var floatBtn = document.createElement('div');
        floatBtn.id = 'vcp-float-btn';
        floatBtn.title = 'VCP 视觉卡片系统 (点击打开控制面板)';
        floatBtn.style.cssText = 
          'position: fixed; right: 24px; bottom: 24px; width: 44px; height: 44px;' +
          'border-radius: 50%; background: linear-gradient(135deg, #2563eb, #0d9488);' +
          'color: #ffffff; display: flex; align-items: center; justify-content: center;' +
          'box-shadow: 0 6px 20px rgba(37, 99, 235, 0.45); border: 1.5px solid rgba(255,255,255,0.3);' +
          'cursor: pointer; z-index: 2147483646; font-size: 18px; user-select: none;' +
          'transition: transform 0.2s ease, box-shadow 0.2s ease;';
        floatBtn.innerHTML = '<span>🎨</span>';
        floatBtn.onmouseenter = function () { floatBtn.style.transform = 'scale(1.08)'; };
        floatBtn.onmouseleave = function () { floatBtn.style.transform = 'scale(1)'; };
        floatBtn.onclick = function (e) {
          e.stopPropagation();
          togglePanel();
        };
        document.body.appendChild(floatBtn);
        floatBtnEl = floatBtn;
      }
    }

    // ---- 启动与循环监听 ---------------------------------------------------
    function whenBodyReady(fn) {
      if (document.body) { fn(); return; }
      document.addEventListener('DOMContentLoaded', function () { fn(); }, { once: true });
      var t = setInterval(function () {
        if (document.body) {
          clearInterval(t);
          fn();
        }
      }, 50);
    }

    whenBodyReady(function () {
      if (isDisposed) return;
      // 清理旧的遗留包装并还原元素
      var oldWrappers = document.querySelectorAll('.dsx-vcp-card-wrapper');
      for (var w = 0; w < oldWrappers.length; w++) {
        if (oldWrappers[w].parentNode) oldWrappers[w].parentNode.removeChild(oldWrappers[w]);
      }
      var allProcessed = document.querySelectorAll('[data-dsx-vcp-processed="1"], [data-dsx-vcp-text-scanned="1"]');
      for (var ap = 0; ap < allProcessed.length; ap++) {
        allProcessed[ap].style.display = '';
        delete allProcessed[ap].dataset.dsxVcpProcessed;
        delete allProcessed[ap].dataset.dsxVcpTextScanned;
      }

      setupUI();
      scanAndRender();

      // 定期扫描与 UI 巡检 (每 300ms 扫描一次，检测流式生成完成的卡片)
      ctx.every(300, function () {
        if (isDisposed) return;
        if (!document.getElementById('vcp-float-btn') || !document.getElementById('vcp-hud-btn')) {
          setupUI();
        }
        scanAndRender();
      });

      // 观察 DOM 变动加速首帧捕获
      var disconnectObserver = ctx.observe(function () {
        scanAndRender();
      });
      cleanups.push(disconnectObserver);
    });

    // 卸载钩子
    this._c = function () {
      isDisposed = true;
      cleanups.forEach(function (f) { try { f(); } catch (e) {} });
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      if (hudBtnEl && hudBtnEl.parentNode) hudBtnEl.parentNode.removeChild(hudBtnEl);
      if (floatBtnEl && floatBtnEl.parentNode) floatBtnEl.parentNode.removeChild(floatBtnEl);
      // 还原所有隐藏的原始代码块与段落
      var hiddenNodes = document.querySelectorAll('[data-dsx-vcp-processed="1"]');
      for (var i = 0; i < hiddenNodes.length; i++) {
        hiddenNodes[i].style.display = '';
        delete hiddenNodes[i].dataset.dsxVcpProcessed;
      }
      var cards = document.querySelectorAll('.dsx-vcp-card-wrapper');
      for (var c = 0; c < cards.length; c++) {
        if (cards[c].parentNode) cards[c].parentNode.removeChild(cards[c]);
      }
    };

    ctx.log('VCP HTML Card Render Plugin v2.1.0 已加载');
  },

  onUnload: function () {
    if (this._c) this._c();
  }
};