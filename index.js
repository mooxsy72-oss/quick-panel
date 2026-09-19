(function () {
    'use strict';

    const BTN_ID    = 'qp-btn';
    const PANEL_ID  = 'qp-panel';
    const LS_ITEMS  = 'qpItems';
    const LS_BTNPOS = 'qpBtnPos';
    const LS_BOX_D  = 'qpPanelBox';
    const LS_BOX_M  = 'qpPanelBoxM';
    const LS_CFG    = 'qpConfig';
    const DRAG_THRESHOLD = 8;
    const LONGPRESS_MS = 500;
    const OWN = '#qp-panel, #qp-btn, #qp-hl, #qp-toast, #qp-settings';

    const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
    const boxKey = () => isMobile() ? LS_BOX_M : LS_BOX_D;

    function lsGet(k, def) {
        try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? def : v; }
        catch (e) { return def; }
    }
    function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

    const LS_FOLDERS = 'qpFolders';

    let items = lsGet(LS_ITEMS, []);
    let folders = lsGet(LS_FOLDERS, []); // [{id, name, collapsed}]
    window.qpDebug = { get items() { return items; }, get folders() { return folders; }, resolveItem, fpScore, fingerprint, stateNode, sigOf, stateOf, markerPair };
   
    let cfg   = Object.assign({ float: true, wand: true, icon: 'fa-bolt', accent: 'quote', accentColor: '#6aa9ff' }, lsGet(LS_CFG, {}));

    const saveItems   = () => lsSet(LS_ITEMS, items.map(({ _el, _missAt, ...rest }) => rest));
    const saveCfg     = () => lsSet(LS_CFG, cfg);
    const saveFolders = () => lsSet(LS_FOLDERS, folders);

    /* ---------------- ПАПКИ ---------------- */

    function addFolder(name) {
        const id = 'f' + Date.now();
        folders.push({ id, name: (name || 'Новая папка').trim().slice(0, 24), collapsed: false });
        saveFolders();
        renderList();
        return id;
    }
    function renameFolder(id, name) {
        const f = folders.find(x => x.id === id);
        if (f && name && name.trim()) { f.name = name.trim().slice(0, 24); saveFolders(); }
    }
    function deleteFolder(id) {
        items.forEach(it => { if (it.folder === id) it.folder = ''; });
        folders = folders.filter(f => f.id !== id);
        saveItems(); saveFolders(); renderList();
    }
    function toggleFolderOpen(id) {
        const f = folders.find(x => x.id === id);
        if (f) { f.collapsed = !f.collapsed; saveFolders(); renderList(); }
    }
    // Массовое вкл/выкл всех тоглов внутри папки
    function setGroupState(folderId, wantOn) {
        let touched = 0;
        items.filter(it => it.folder === folderId).forEach(it => {
            if (it.ad) {
                const st = adState(it);
                if (st !== 'missing' && (st === 'on') !== wantOn) { adFire(it); touched++; }
                return;
            }
            const t = resolveItem(it);
            if (!t || !isToggleLike(t)) return;
            const cur = stateOf(it, t) === 'on';
            if (cur !== wantOn) { fire(t); touched++; }
        });
        toast(touched ? (wantOn ? 'Включаю тоглы группы…' : 'Выключаю тоглы группы…') : 'В папке нет тоглов с известным состоянием');
        [150, 400, 900].forEach(ms => setTimeout(syncStates, ms));
    }

    /* ---------------- СЕЛЕКТОРЫ ---------------- */

    const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');

    const STATE_CLS = /(^|[-_])(disabled|enabled|active|selected|checked|open|closed|down|up|on|off|lock|unlock|flash|hover)([-_]|$)|openIcon|closedIcon|displayNone|toggleEnabled|openDrawer|closedDrawer|drawer-content|flex(?![-_])/i;
    const KEY_ATTRS = ['data-pm-identifier', 'data-pm-prompt-id', 'data-id', 'name'];

    function selectorFor(el) {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body) {
            if (node.id && document.querySelectorAll('#' + esc(node.id)).length === 1) {
                parts.unshift('#' + esc(node.id));
                break;
            }
            let sel = node.tagName.toLowerCase();
            let hasAttr = false;
            for (const a of KEY_ATTRS) {
                const v = node.getAttribute(a);
                if (v) { sel += `[${a}="${v.replace(/"/g, '\\"')}"]`; hasAttr = true; break; }
            }
            const cls = Array.from(node.classList)
                .filter(c => !/^(qp-|ui-|hover|dragging)/.test(c) && !STATE_CLS.test(c)).slice(0, 3);
            if (cls.length) sel += '.' + cls.map(esc).join('.');
            const p = node.parentElement;
            if (p && !hasAttr) {
                const same = Array.from(p.children).filter(c => c.tagName === node.tagName);
                if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
            }
            parts.unshift(sel);
            node = p;
        }
        const out = parts.join(' > ');
        try { if (document.querySelector(out) === el) return out; } catch (e) {}
        return out;
    }

    const INTERACTIVE = 'input, select, button, a, [role="button"], [role="option"], [role="menuitem"], [role="tab"], .menu_button, .interactable, .list-group-item, label, .inline-drawer-toggle, .drawer-toggle, .inline-drawer-header, .right_menu_button, .extensionsMenuExtensionButton, .select2-results__option, .select2-selection, i[class*="fa-"], span[class*="fa-"], [onclick], .clickable, .toggleEnabled, [class*="toggle"], [class*="header"], [class*="tab"], h3, h4, h5';

    function findInteractive(el) {
        if (!el || !el.closest) return null;
        // select2 (выбор лорбука и т.п.): пункт выпадашки -> подменяем на нативный select
        const s2opt = el.closest('.select2-results__option');
        if (s2opt) {
            const m = /^select2-(.+?)-result/.exec(s2opt.id || '');
            const orig = m ? document.getElementById(m[1]) : null;
            if (orig && orig.tagName === 'SELECT') return orig;
        }
        const s2box = el.closest('.select2-container');
        if (s2box) {
            const prev = s2box.previousElementSibling;
            if (prev && prev.tagName === 'SELECT') return prev;
        }
        // Приоритет: кнопка с id важнее обёртки
        let hit = el.closest('button, input, select, a, .menu_button, .inline-drawer-toggle, .drawer-toggle, .inline-drawer-header, h3, h4, h5, [class*="section-toggle"], [class*="section_toggle"]')
               || el.closest(INTERACTIVE);

        // Фолбэк: кастомные кнопки сторонних расширений без семантики (FAB и т.п.,
        // клик навешан через addEventListener, атрибутов/классов-маркеров нет).
        // Определяем по cursor:pointer, поднимаясь на пару уровней вверх.
        if (!hit) {
            let node = el;
            for (let i = 0; i < 4 && node && node.nodeType === 1 && node !== document.body; i++) {
                if (getComputedStyle(node).cursor === 'pointer') { hit = node; break; }
                node = node.parentElement;
            }
        }
        if (!hit) return null;
        hit = promoteListItem(hit);
        const r = hit.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.85 && r.height > window.innerHeight * 0.5) return null;
        if (hit.tagName === 'LABEL') {
            const i = hit.querySelector('input');
            if (i) return i;
        }
        return hit;
    }

    // Повторяющийся элемент списка (пресеты стилей, карточки и т.п.):
    // у родителя >=2 соседа с тем же тегом и тем же набором стабильных классов.
    function isListItem(el) {
        const p = el && el.parentElement;
        if (!p || el === document.body) return false;
        const c = stableCls(el);
        if (!c) return false;
        let n = 0;
        for (const sib of p.children) {
            if (sib.tagName === el.tagName && stableCls(sib) === c && ++n >= 2) return true;
        }
        return false;
    }

    // Кастомные списки (div-карточки без семантики): если кликнули во внутренний
    // текст/блок карточки, поднимаемся до самой карточки. Иконки и нативные
    // кнопки внутри карточки (звёздочка и т.п.) не трогаем — их выбирают намеренно.
    function promoteListItem(hit) {
        if (hit.matches(NATIVE_CLICKABLE + ', label, i[class*="fa-"], span[class*="fa-"]')) return hit;
        if (isListItem(hit)) return hit;
        let node = hit.parentElement;
        for (let i = 0; i < 5 && node && node !== document.body; i++) {
            if (node.closest(OWN)) break;
            if (isListItem(node)) {
                let cur = 'auto';
                try { cur = getComputedStyle(node).cursor; } catch (e) {}
                const r = node.getBoundingClientRect();
                if (cur === 'pointer' && !(r.width > window.innerWidth * 0.85 && r.height > window.innerHeight * 0.5)) return node;
                break;
            }
            node = node.parentElement;
        }
        return hit;
    }

    const txtOf  = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const txtKey = (t) => String(t || '').replace(/\d+/g, '#');

    function nameFor(el) {
        const lbl = el.closest('label');
        let t = (el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
        if (!t && lbl) t = lbl.textContent.trim();
        if (!t) t = (el.textContent || '').trim();
        if (!t) t = el.getAttribute('id') || el.className.split(' ')[0] || 'Кнопка';
        return t.replace(/\s+/g, ' ').slice(0, 24);
    }

    function iconFor(el) {
        const i = el.querySelector('i[class*="fa-"], .fa-solid, .fa-regular')
               || (el.matches('i[class*="fa-"]') ? el : null);
        if (i) {
            const m = Array.from(i.classList).find(c => /^fa-(?!solid|regular|brands|fw|lg)/.test(c));
            if (m) return 'fa-solid ' + m;
        }
        if (el.matches('input[type=checkbox]')) return 'fa-solid fa-toggle-on';
        return 'fa-solid fa-circle-dot';
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== 'hidden';
    }

    function revealParents(el) {
        const opened = [];
        let node = el.parentElement;
        while (node && node !== document.body) {
            if (node.classList.contains('inline-drawer-content') && !isVisible(node)) {
                const t = node.closest('.inline-drawer')?.querySelector('.inline-drawer-toggle');
                if (t) { t.click(); opened.push(t); }
            }
            if (node.classList.contains('drawer-content') && !isVisible(node)) {
                const t = node.closest('.drawer')?.querySelector('.drawer-toggle');
                if (t) { t.click(); opened.push(t); }
            }
            node = node.parentElement;
        }
        return opened;
    }

    function isDrawerHead(el) {
        if (el.matches('.inline-drawer-toggle, .drawer-toggle, .inline-drawer-header, h3, h4, h5')) return true;
        // Кастомные заголовки-раскрывашки: section-toggle, drawer-header, panel-toggle и т.п.
        const cn = String(el.className || '');
        return /(section|drawer|panel|category|group|accordion|collaps\w*)[-_]?(toggle|header|head)/i.test(cn)
            || /(toggle|header)[-_]?(section|panel|category|group)/i.test(cn);
    }

    function isToggleLike(el) {
        if (isDrawerHead(el)) return false;
        return el.matches('input[type="checkbox"], input[type="radio"]')
            || /fa-toggle-(on|off)/.test(el.className || '')
            || /(^|[-_\s])toggle([-_\s]|$)/i.test(el.className || '');
    }

    // Многие кастомные FAB/виджеты (плавающие кнопки с drag-жестом) слушают
    // pointerdown/pointerup, а не click — синтетический el.click() для них молчит.
    // Для нативно кликабельных тегов click() достаточен и безопаснее (не дублируем событие).
    const NATIVE_CLICKABLE = 'button, a, input, select, [role="button"], [role="tab"], [role="menuitem"], [role="option"]';

    function simulateTap(el) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const base = {
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy, view: window,
            pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0
        };
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
            el.dispatchEvent(new MouseEvent('mousedown',     { ...base, buttons: 1 }));
            el.dispatchEvent(new PointerEvent('pointerup',   { ...base, buttons: 0 }));
            el.dispatchEvent(new MouseEvent('mouseup',       { ...base, buttons: 0 }));
            el.dispatchEvent(new MouseEvent('click',         { ...base, buttons: 0 }));
        } catch (e) {
            el.click();
        }
    }

    function fire(el) {
        // 0. Парные маркеры (ExtBlocks и подобные): кликаем по видимому span'у,
        //    а не по спрятанному — иначе чип работает только в одну сторону
        const pair = markerPair(el);
        if (pair) { pair.click(); return; }

        // 1. Тоглы и чекбоксы — клик ровно по себе
        if (isToggleLike(el)) { el.click(); return; }

        // 2. Заголовок-раскрывашка, но только если это САМ выбранный элемент
        if (isDrawerHead(el)) {
            const opened = revealParents(el);
            if (opened.length) setTimeout(() => el.click(), 300);
            else el.click();
            return;
        }

        // 3. Всё остальное. Нативные теги — обычный click().
        //    Кастомные div/span-кнопки (FAB и т.п.) — полная имитация тапа,
        //    т.к. они часто слушают pointerdown/pointerup, а не click.
        //    Никакого всплытия к предкам: именно оно било по #extensions-settings-button
        //    и дёргало чужие чекбоксы вместо нужной кнопки.
        if (el.matches(NATIVE_CLICKABLE)) el.click();
        else simulateTap(el);
    }

    /* ---------------- ТОСТ ---------------- */

    let toastEl = null, toastTimer = null;
    function toast(text) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'qp-toast';
            toastEl.setAttribute('popover', 'manual');
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        try { toastEl.showPopover(); } catch (e) {}
        toastEl.classList.add('qp-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('qp-show');
            setTimeout(() => { try { toastEl.hidePopover(); } catch (e) {} }, 250);
        }, 1800);
    }


    /* ---------------- РЕЖИМ ВЫБОРА ---------------- */

    let picking = false, hl = null;

    function startPick() {
        if (picking) return;
        picking = true;
        document.body.classList.add('qp-picking');
        if (panel) panel.classList.add('qp-picking-active');
        if (!hl) {
            hl = document.createElement('div');
            hl.id = 'qp-hl';
            hl.setAttribute('popover', 'manual');
            hl.innerHTML = '<span class="qp-hl-tag"></span>';
            document.body.appendChild(hl);
        }
        hl.classList.add('qp-show');
        try { hl.showPopover(); } catch (e) {}
        toast('Кликни по кнопке или тоглу чтобы добавить. Повторный клик прицела — выкл.');
        document.addEventListener('pointermove', onPickMove, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
    }

    function stopPick() {
        picking = false;
        document.body.classList.remove('qp-picking');
        if (panel) panel.classList.remove('qp-picking-active');
        if (hl) {
            hl.classList.remove('qp-show');
            try { hl.hidePopover(); } catch (e) {}
        }
        document.removeEventListener('pointermove', onPickMove, true);
        document.removeEventListener('click', onPickClick, true);
        document.removeEventListener('keydown', onPickKey, true);
    }

    function pickTarget(e) {
        // composedPath достаёт реальный элемент даже из shadow DOM (horae и т.п.)
        const path = e.composedPath ? e.composedPath() : null;
        return (path && path[0] && path[0].nodeType === 1) ? path[0] : e.target;
    }

    function onPickMove(e) {
        const raw = pickTarget(e);
        if (!raw || raw.closest?.(OWN)) { hl.style.opacity = '0'; return; }
        const el = findInteractive(raw);
        if (!el) { hl.style.opacity = '0'; return; }
        const r = el.getBoundingClientRect();
        hl.style.opacity = '1';
        hl.style.left   = r.left + 'px';
        hl.style.top    = r.top + 'px';
        hl.style.width  = r.width + 'px';
        hl.style.height = r.height + 'px';
        hl.querySelector('.qp-hl-tag').textContent = nameFor(el);
    }

    function onPickClick(e) {
        const raw = pickTarget(e);
        if (raw.closest?.('.qp-pick') || raw.closest?.('#qp-btn')) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            stopPick();
            toast('Селектор выключен');
            return;
        }
        if (raw.closest?.(OWN)) { e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        const el = findInteractive(raw);
        if (!el) { toast('Это не кнопка. Выбери кликабельный элемент.'); return; }
        addItem(el);
        // селектор НЕ выключаем — собирай дальше, выключение прицелом или Esc
    }


    function onPickKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); stopPick(); toast('Отменено'); }
    }

    /* ---------------- АДАПТЕРЫ (элементы, которые кликом не переключить) ---------------- */
    // Некоторые расширения рисуют карточки, на которые синтетический клик не действует.
    // Для них чип меняет настройку напрямую — работает, даже если список сейчас не отрисован.

    function stCtx() { try { return SillyTavern.getContext(); } catch (e) { return null; } }
    const normSp = (t) => String(t || '').trim().replace(/\s+/g, ' ');

    const ADAPTERS = {
        // Inline Image Generation — пресеты стилей
        iigStyle: {
            card: '.iig-style-item',
            icon: 'fa-solid fa-palette',
            cfg() { const c = stCtx(); return c && c.extensionSettings && c.extensionSettings.inline_image_gen || null; },
            list() { const c = this.cfg(); return c && Array.isArray(c.styles) ? c.styles : []; },
            keyOf(card) {
                const styles = this.list();
                if (!styles.length) return '';
                // 1) id стиля в любом атрибуте карточки
                for (const a of card.attributes) {
                    const hit = styles.find(s => s.id === a.value);
                    if (hit) return hit.id;
                }
                // 2) по названию: текст карточки начинается с имени стиля (берём самое длинное совпадение)
                const txt = normSp(card.textContent);
                let best = null;
                for (const s of styles) {
                    const n = normSp(s.name);
                    if (n && txt.startsWith(n) && (!best || n.length > best.n.length)) best = { id: s.id, n };
                }
                return best ? best.id : '';
            },
            nameOf(key) { const s = this.list().find(x => x.id === key); return s ? s.name : ''; },
            exists(key) { return this.list().some(x => x.id === key); },
            isOn(key) { const c = this.cfg(); return !!c && c.activeStyleId === key; },
            toggle(key) {
                const c = this.cfg();
                if (!c) return false;
                c.activeStyleId = c.activeStyleId === key ? '' : key;
                const ctx = stCtx();
                try { ctx.saveSettingsDebounced(); } catch (e) {}
                this.repaint();
                return c.activeStyleId === key;
            },
            // Подсветить активную карточку в настройках расширения, если список сейчас открыт
            repaint() {
                const c = this.cfg();
                document.querySelectorAll(this.card).forEach(card => {
                    const on = !!c && this.keyOf(card) === c.activeStyleId && !!c.activeStyleId;
                    card.classList.toggle('iig-style-item-active', on);
                });
            }
        }
    };

    const AD_SKIP = /star|fav|heart|trash|delete|remove|edit|pen|copy|dup|clone|tag/i;
    function adapterFor(el) {
        if (!el || !el.closest) return null;
        for (const [id, ad] of Object.entries(ADAPTERS)) {
            const card = el.closest(ad.card);
            if (!card) continue;
            if (el !== card) {
                // звёздочку, корзину и т.п. внутри карточки оставляем обычными кнопками
                const ctl = el.closest('button, [role="button"]') || el;
                if (AD_SKIP.test(String(el.className || '')) || AD_SKIP.test(String(ctl.className || '')) || AD_SKIP.test(ctl.getAttribute('title') || '')) return null;
            }
            return { id, ad, card };
        }
        return null;
    }

    function adState(it) {
        const ad = ADAPTERS[it.ad];
        if (!ad || !ad.exists(it.key)) return 'missing';
        const on = ad.isOn(it.key);
        return (it.inv ? !on : on) ? 'on' : 'off';
    }

    function adFire(it) {
        const ad = ADAPTERS[it.ad];
        if (!ad || !ad.exists(it.key)) { toast('Стиль не найден — возможно, удалён'); return; }
        const on = ad.toggle(it.key);
        toast((on ? 'Стиль включён: ' : 'Стиль выключен: ') + ad.nameOf(it.key));
    }

    function addItem(el) {
        const hitAd = adapterFor(el);
        if (hitAd) {
            const key = hitAd.ad.keyOf(hitAd.card);
            if (key) {
                if (items.some(i => i.ad === hitAd.id && i.key === key)) { toast('Уже добавлено'); return; }
                items.push({
                    id: 'i' + Date.now(), ad: hitAd.id, key, sel: '', fp: null,
                    name: (hitAd.ad.nameOf(key) || nameFor(el)).slice(0, 24),
                    icon: hitAd.ad.icon, folder: ''
                });
                saveItems(); renderList();
                toast('Добавлено: ' + items[items.length - 1].name);
                return;
            }
        }
        const sel = selectorFor(el);
        const eid = el.id || '';
        if (items.some(i => i.fp && i.fp.eid && i.fp.eid === eid && eid)) {
            toast('Уже добавлено (совпадает id)');
            return;
        }
        if (items.some(i => i.sel === sel)) {
            toast('Уже добавлено (совпадает селектор)');
            return;
        }
        const id = 'i' + Date.now();
        el.setAttribute('data-qp-id', id);
        const fp = fingerprint(el);
        fp.aid = id;
        items.push({
            id, sel, _el: el, fp,
            name: nameFor(el),
            icon: iconFor(el),
            title: el.getAttribute('title') || '',
            txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
            folder: ''
        });
        saveItems();
        renderList();
        toast('Добавлено: ' + items[items.length - 1].name);
    }

    /* ---------------- ПАНЕЛЬ ---------------- */

    let panel = null, listEl = null, tickTimer = null;

    function buildPanel() {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="qp-head">
                <span class="qp-title"><i class="fa-solid fa-heart"></i> Твои кнопочки</span>
                <div class="qp-acts">
                    <div class="qp-ico qp-pin" title="Закрепить"><i class="fa-solid fa-thumbtack"></i></div>
                    <div class="qp-ico qp-pick" title="Добавить (зажми элемент)"><i class="fa-solid fa-crosshairs"></i></div>
                    <div class="qp-ico qp-edit" title="Переименовать"><i class="fa-solid fa-pen"></i></div>
                    <div class="qp-ico qp-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div class="qp-body"><div class="qp-list"></div></div>
            <div class="qp-grip"></div>`;

        document.body.appendChild(panel);
         ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(ev =>
            panel.addEventListener(ev, (e) => e.stopPropagation()));       
        listEl = panel.querySelector('.qp-list');
        listEl.addEventListener('contextmenu', (e) => {
            if (panel.classList.contains('qp-editing')) e.preventDefault();
        });
        const pinned = lsGet('qpPinned', false);
        if (pinned) panel.classList.add('qp-pinned');

        panel.querySelector('.qp-pin').addEventListener('click', () => {
            panel.classList.toggle('qp-pinned');
            const p = panel.classList.contains('qp-pinned');
            lsSet('qpPinned', p);
            toast(p ? 'Панель закреплена' : 'Панель откреплена');
        });

        const box = lsGet(boxKey(), null);
        if (box) {
            if (box.width)  panel.style.width  = clamp(box.width, 150, window.innerWidth - 16) + 'px';
            if (box.height) panel.style.height = clamp(box.height, 140, window.innerHeight - 16) + 'px';
        }

        panel.querySelector('.qp-close').addEventListener('click', closePanel);
        panel.querySelector('.qp-pick').addEventListener('click', () => {
            if (picking) stopPick();
            else startPick();
        });

        panel.querySelector('.qp-edit').addEventListener('click', () => {
            cancelDrag();
            panel.classList.toggle('qp-editing');
            renderList();
        });

        panel.querySelector('.qp-head').addEventListener('dblclick', (e) => {
            if (e.target.closest('.qp-ico')) return;
            if (panel.classList.contains('qp-pinned')) return;
            try { localStorage.removeItem(boxKey()); } catch (err) {}
            panel.style.width = '200px';
            panel.style.height = '230px';
            requestAnimationFrame(() => placePanel(true));
        });

        applyLook();
        makeDraggable(panel, panel.querySelector('.qp-head'));
        makeResizable(panel, panel.querySelector('.qp-grip'));
        renderList();
    }

    /* ---------------- ПЕРЕТАСКИВАНИЕ (режим редактирования) ---------------- */
    // Телефон: зажать ~0.4с и тянуть. Мышь: просто потянуть чуть дальше порога.

    const DND_HOLD_MS = 380;
    const NO_DRAG = '.qp-chip-del, .qp-chip-tools, .qp-folder-tools, .qp-rename, select, input';
    let dnd = null;          // текущее состояние
    let dndEndedAt = 0;      // чтобы гасить click сразу после перетаскивания
    let dndGlobalsBound = false;

    const justDragged = () => Date.now() - dndEndedAt < 400;
    const isEditing = () => panel && panel.classList.contains('qp-editing');

    function armDrag(el, kind, id) {
        bindDndGlobals();
        el.addEventListener('touchstart', (e) => {
            if (!isEditing() || e.touches.length !== 1 || e.target.closest(NO_DRAG)) return;
            cancelDrag();
            const t = e.touches[0];
            const st = dnd = { kind, id, src: el, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, mode: 'touch', active: false };
            st.timer = setTimeout(() => { if (dnd === st) beginDrag(st); }, DND_HOLD_MS);
        }, { passive: true });
        el.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse' || e.button !== 0 || !isEditing() || e.target.closest(NO_DRAG)) return;
            cancelDrag();
            dnd = { kind, id, src: el, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, mode: 'mouse', active: false };
        });
    }

    function bindDndGlobals() {
        if (dndGlobalsBound) return;
        dndGlobalsBound = true;

        document.addEventListener('touchmove', (e) => {
            if (!dnd || dnd.mode !== 'touch') return;
            const t = e.touches[0];
            if (!dnd.active) {
                // палец поехал до срабатывания зажатия — это обычный скролл
                if (Math.hypot(t.clientX - dnd.sx, t.clientY - dnd.sy) > 10) cancelDrag();
                return;
            }
            if (e.cancelable) e.preventDefault();
            moveDrag(t.clientX, t.clientY);
        }, { passive: false, capture: true });
        document.addEventListener('touchend',    () => { if (dnd && dnd.mode === 'touch') finishDrag(true);  }, true);
        document.addEventListener('touchcancel', () => { if (dnd && dnd.mode === 'touch') finishDrag(false); }, true);

        document.addEventListener('pointermove', (e) => {
            if (!dnd || dnd.mode !== 'mouse') return;
            if (!dnd.active) {
                if (Math.hypot(e.clientX - dnd.sx, e.clientY - dnd.sy) < 6) return;
                beginDrag(dnd);
            }
            e.preventDefault();
            moveDrag(e.clientX, e.clientY);
        }, true);
        document.addEventListener('pointerup', (e) => {
            if (dnd && dnd.mode === 'mouse') finishDrag(true);
        }, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dnd && dnd.active) { e.stopPropagation(); finishDrag(false); }
        }, true);
    }

    function beginDrag(st) {
        if (!st.src.isConnected) { cancelDrag(); return; }
        st.active = true;
        const r = st.src.getBoundingClientRect();
        st.offX = st.x - r.left;
        st.offY = st.y - r.top;
        const g = st.ghost = st.src.cloneNode(true);
        g.classList.add('qp-ghost');
        g.removeAttribute('data-qp-item-id');
        g.removeAttribute('data-qp-folder-id');
        g.style.width = r.width + 'px';
        g.style.left = r.left + 'px';
        g.style.top = r.top + 'px';
        document.body.appendChild(g);

        st.src.classList.add('qp-drag-src');
        if (st.kind === 'folder') {
            listEl.querySelectorAll('.qp-chip').forEach(c => {
                if (c.dataset.qpFolder === st.id) c.classList.add('qp-drag-src');
            });
        }
        panel.classList.add('qp-dnd');
        document.body.classList.add('qp-dnd-active');
        try { navigator.vibrate && navigator.vibrate(12); } catch (e) {}

        const body = panel.querySelector('.qp-body');
        st.scrollIv = setInterval(() => {
            const br = body.getBoundingClientRect();
            const edge = 32;
            let d = 0;
            if (st.y < br.top + edge) d = -Math.ceil((br.top + edge - st.y) / 4);
            else if (st.y > br.bottom - edge) d = Math.ceil((st.y - (br.bottom - edge)) / 4);
            if (d) { body.scrollTop += d; computeDrop(st); }
        }, 16);
        moveDrag(st.x, st.y);
    }

    function moveDrag(x, y) {
        const st = dnd;
        if (!st || !st.active) return;
        st.x = x; st.y = y;
        st.ghost.style.left = (x - st.offX) + 'px';
        st.ghost.style.top  = (y - st.offY) + 'px';
        computeDrop(st);
    }

    function clearDropMarks() {
        if (!listEl) return;
        listEl.querySelectorAll('.qp-drop-before, .qp-drop-after, .qp-drop-into')
            .forEach(n => n.classList.remove('qp-drop-before', 'qp-drop-after', 'qp-drop-into'));
        listEl.classList.remove('qp-drop-end');
    }

    function computeDrop(st) {
        clearDropMarks();
        st.target = null;
        const hitEl = document.elementFromPoint(st.x, st.y);
        const body = panel.querySelector('.qp-body');
        if (!hitEl || !body.contains(hitEl)) return;

        const node = hitEl.closest('.qp-chip[data-qp-item-id], .qp-folder[data-qp-folder-id]');
        const lastOfFolder = (fid) => {
            const arr = listEl.querySelectorAll('.qp-chip[data-qp-folder="' + fid + '"]');
            return arr.length ? arr[arr.length - 1] : listEl.querySelector('.qp-folder[data-qp-folder-id="' + fid + '"]');
        };
        const firstRoot = () => listEl.querySelector('.qp-chip[data-qp-folder=""]');

        if (st.kind === 'item') {
            if (!node) { st.target = { type: 'end' }; listEl.classList.add('qp-drop-end'); return; }
            if (node === st.src) return;
            if (node.classList.contains('qp-folder')) {
                st.target = { type: 'folder', id: node.dataset.qpFolderId };
                node.classList.add('qp-drop-into');
                return;
            }
            const r = node.getBoundingClientRect();
            const after = st.y > r.top + r.height / 2;
            st.target = { type: 'item', id: node.dataset.qpItemId, after };
            node.classList.add(after ? 'qp-drop-after' : 'qp-drop-before');
            return;
        }

        // перетаскиваем папку
        let fid = null, after = false;
        if (node && node.classList.contains('qp-folder')) {
            fid = node.dataset.qpFolderId;
            const r = node.getBoundingClientRect();
            after = st.y > r.top + r.height / 2;
        } else if (node && node.dataset.qpFolder) {
            fid = node.dataset.qpFolder; after = true;      // над чипом чужой папки = после этой папки
        }
        if (fid === st.id) return;
        if (fid) {
            st.target = { type: 'folder', id: fid, after };
            const head = listEl.querySelector('.qp-folder[data-qp-folder-id="' + fid + '"]');
            if (after) lastOfFolder(fid).classList.add('qp-drop-after');
            else head.classList.add('qp-drop-before');
        } else {
            st.target = { type: 'end' };                     // корневые чипы / пустое место = в конец папок
            const fr = firstRoot();
            if (fr) fr.classList.add('qp-drop-before'); else listEl.classList.add('qp-drop-end');
        }
    }

    function cancelDrag() { finishDrag(false); }

    function finishDrag(commit) {
        const st = dnd;
        if (!st) return;
        dnd = null;
        clearTimeout(st.timer);
        if (!st.active) return;
        clearInterval(st.scrollIv);
        if (st.ghost) st.ghost.remove();
        clearDropMarks();
        if (panel) panel.classList.remove('qp-dnd');
        document.body.classList.remove('qp-dnd-active');
        listEl && listEl.querySelectorAll('.qp-drag-src').forEach(n => n.classList.remove('qp-drag-src'));
        dndEndedAt = Date.now();
        if (commit && st.target) {
            if (st.kind === 'item') dropItem(st.id, st.target);
            else dropFolder(st.id, st.target);
        }
        renderList();
    }

    function dropItem(id, tgt) {
        const it = items.find(x => x.id === id);
        if (!it) return;
        const from = items.indexOf(it);
        items.splice(from, 1);
        if (tgt.type === 'item') {
            const other = items.find(x => x.id === tgt.id);
            if (!other) { items.splice(from, 0, it); return; }
            it.folder = other.folder || '';
            items.splice(items.indexOf(other) + (tgt.after ? 1 : 0), 0, it);
        } else if (tgt.type === 'folder') {
            it.folder = tgt.id;
            const f = folders.find(x => x.id === tgt.id);
            if (f && f.collapsed) { f.collapsed = false; saveFolders(); }
            const first = items.findIndex(x => x.folder === tgt.id);
            items.splice(first < 0 ? items.length : first, 0, it);
        } else {
            it.folder = '';
            items.push(it);
        }
        saveItems();
    }

    function dropFolder(id, tgt) {
        const f = folders.find(x => x.id === id);
        if (!f) return;
        folders.splice(folders.indexOf(f), 1);
        const ti = tgt.type === 'folder' ? folders.findIndex(x => x.id === tgt.id) : -1;
        if (ti >= 0) folders.splice(ti + (tgt.after ? 1 : 0), 0, f);
        else folders.push(f);
        saveFolders();
    }

    function buildFolderHeader(f, count) {
        const head = document.createElement('div');
        head.className = 'qp-folder' + (f.collapsed ? ' qp-folder-collapsed' : '');
        head.dataset.qpFolderId = f.id;
        head.innerHTML =
            '<i class="fa-solid fa-chevron-down qp-folder-arrow"></i>' +
            '<i class="fa-solid fa-folder qp-folder-ic"></i>' +
            '<span class="qp-folder-name"></span>' +
            '<span class="qp-folder-count"></span>' +
            '<div class="qp-folder-tools">' +
                '<i class="fa-solid fa-toggle-on qp-t qp-folder-on" title="Включить все тоглы папки"></i>' +
                '<i class="fa-solid fa-toggle-off qp-t qp-folder-off" title="Выключить все тоглы папки"></i>' +
                '<i class="fa-solid fa-pen qp-t qp-folder-ren" title="Переименовать папку"></i>' +
                '<i class="fa-solid fa-trash qp-t qp-folder-del" title="Удалить папку"></i>' +
            '</div>';
        head.querySelector('.qp-folder-name').textContent = f.name;
        head.querySelector('.qp-folder-count').textContent = count;

        armDrag(head, 'folder', f.id);
        head.addEventListener('click', (e) => {
            if (justDragged()) return;
            if (e.target.closest('.qp-folder-ren')) {
                const name = prompt('Название папки', f.name);
                if (name && name.trim()) renameFolder(f.id, name);
                renderList();
                return;
            }
            if (e.target.closest('.qp-folder-del')) {
                if (confirm('Удалить папку «' + f.name + '»? Элементы останутся в списке, просто без папки.')) deleteFolder(f.id);
                return;
            }
            if (e.target.closest('.qp-folder-on'))  { setGroupState(f.id, true);  return; }
            if (e.target.closest('.qp-folder-off')) { setGroupState(f.id, false); return; }
            toggleFolderOpen(f.id);
        });
        return head;
    }

    function buildChip(it) {
        const target = resolveItem(it);
        const present = it.ad ? adState(it) !== 'missing' : !!target;
        const chip = document.createElement('div');
        chip.className = 'qp-chip' + (present ? '' : ' qp-missing') + (it.folder ? ' qp-chip-nested' : '');
        chip.dataset.qpItemId = it.id;
        chip.title = present ? it.name : 'Элемент не найден на странице';
        const dot = document.createElement('span');
        dot.className = 'qp-chip-dot';
        const ic = document.createElement('i');
        ic.className = it.icon + ' qp-chip-ic';
        const grip = document.createElement('i');
        grip.className = 'fa-solid fa-grip-vertical qp-chip-grip';
        const label = document.createElement('span');
        label.className = 'qp-chip-lb';
        label.textContent = it.name;
        chip.append(grip, dot, ic, label);
        chip.dataset.qpFolder = it.folder || '';

        if (target && target.tagName === 'SELECT' && !panel.classList.contains('qp-editing')) {
            const sel = document.createElement('select');
            sel.className = 'qp-chip-sel';
            sel.title = it.name;
            Array.from(target.options).forEach(o => {
                const op = document.createElement('option');
                op.value = o.value; op.textContent = o.textContent;
                sel.appendChild(op);
            });
            sel.value = target.value;
            ['pointerdown', 'click'].forEach(ev => sel.addEventListener(ev, ev2 => ev2.stopPropagation()));
            sel.addEventListener('change', (ev2) => {
                ev2.stopPropagation();
                const t = resolveItem(it);
                if (!t) { toast('Элемент не найден'); return; }
                t.value = sel.value;
                t.dispatchEvent(new Event('change', { bubbles: true }));
                t.dispatchEvent(new Event('input', { bubbles: true }));
            });
            label.remove();
            chip.classList.add('qp-has-sel');
            chip.appendChild(sel);
        }

        const del = document.createElement('i');
        del.className = 'fa-solid fa-trash qp-chip-del';
        del.title = 'Удалить';
        chip.appendChild(del);

        const tools = document.createElement('div');
        tools.className = 'qp-chip-tools';
        tools.innerHTML =
            '<i class="fa-solid fa-right-left qp-t qp-inv" title="Перевернуть индикатор"></i>' +
            '<i class="fa-solid fa-circle-info qp-t qp-info" title="Что реально найдено"></i>';

        // Выбор папки — доступен только в режиме редактирования (тулбар и так виден только тогда)
        const folderSel = document.createElement('select');
        folderSel.className = 'qp-chip-folder-sel';
        folderSel.title = 'Переместить в папку';
        folderSel.innerHTML = '<option value="">— без папки —</option>' +
            folders.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
        folderSel.value = it.folder || '';
        ['pointerdown', 'click'].forEach(ev => folderSel.addEventListener(ev, ev2 => ev2.stopPropagation()));
        folderSel.addEventListener('change', () => {
            it.folder = folderSel.value;
            saveItems();
            renderList();
        });
        // Компактно: видна только иконка папки, а нативный select прозрачно лежит поверх неё
        const folderPick = document.createElement('span');
        folderPick.className = 'qp-t qp-fold-pick' + (it.folder ? ' qp-fold-set' : '');
        folderPick.title = 'Переместить в папку';
        folderPick.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
        folderPick.appendChild(folderSel);
        tools.appendChild(folderPick);
        chip.appendChild(tools);
        armDrag(chip, 'item', it.id);

        let longTimer = null;
        chip.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.qp-chip-del, .qp-chip-tools')) return;
            longTimer = setTimeout(() => {
                longTimer = null;
                if (!panel.classList.contains('qp-editing')) startPick();
            }, LONGPRESS_MS);
        });
        ['pointerup', 'pointercancel', 'pointermove'].forEach(ev =>
            chip.addEventListener(ev, () => clearTimeout(longTimer)));

        chip.addEventListener('click', (e) => {
            if (justDragged()) { e.preventDefault(); return; }
            if (e.target.closest('.qp-chip-del')) {
                items.splice(items.indexOf(it), 1); saveItems(); renderList(); return;
            }
            if (panel.classList.contains('qp-editing')) {
                if (e.target.closest('.qp-inv')) { it.inv = !it.inv; saveItems(); syncStates(); toast(it.inv ? 'Индикатор перевёрнут' : 'Индикатор как есть'); return; }
                if (e.target.closest('.qp-info')) {
                    if (it.ad) { toast(it.ad + ' | ' + it.key + ' | ' + adState(it)); return; }
                    const t = resolveItem(it); toast(t ? describe(t) : 'Элемент не найден'); return;
                }
                if (e.target.closest('.qp-fold-pick')) return;
                if (chip.classList.contains('qp-has-sel')) return;
                startRename(chip, label, it);
                return;
            }
            if (chip.classList.contains('qp-has-sel')) return;
            if (it.ad) {
                chip.classList.remove('qp-flash'); void chip.offsetWidth; chip.classList.add('qp-flash');
                adFire(it); syncStates();
                return;
            }
            it._missAt = 0;
            const t = resolveItem(it);
            if (!t) { toast('Элемент не найден. Удали чип и добавь заново.'); renderList(); return; }
            const before = sigOf(t);
            chip.classList.remove('qp-flash');
            void chip.offsetWidth;
            chip.classList.add('qp-flash');
            fire(t);
            [80, 220, 500, 1000, 1800].forEach(ms => setTimeout(() => {
                const t2 = resolveItem(it);
                if (t2) learnSig(it, before, sigOf(t2));
                syncStates();
            }, ms));
        });

        return chip;
    }

    function renderList() {
        if (!listEl) return;
        items.forEach(it => { it._missAt = 0; });
        listEl.innerHTML = '';

        if (panel.classList.contains('qp-editing')) {
            const addFolderBtn = document.createElement('div');
            addFolderBtn.className = 'qp-folder-add';
            addFolderBtn.innerHTML = '<i class="fa-solid fa-folder-plus"></i> Новая папка';
            addFolderBtn.addEventListener('click', () => addFolder('Новая папка'));
            listEl.appendChild(addFolderBtn);
        }

        if (!items.length && !folders.length) {
            const empty = document.createElement('div');
            empty.className = 'qp-empty';
            empty.textContent = 'Пусто. Включи прицел и кликни любой элемент таверны.';
            listEl.appendChild(empty);
            return;
        }

        folders.forEach(f => {
            const group = items.filter(it => it.folder === f.id);
            listEl.appendChild(buildFolderHeader(f, group.length));
            if (!f.collapsed) group.forEach(it => listEl.appendChild(buildChip(it)));
        });

        items.filter(it => !it.folder).forEach(it => listEl.appendChild(buildChip(it)));

        syncStates();
    }

    function startRename(chip, label, it) {
        const input = document.createElement('input');
        input.className = 'qp-rename';
        input.value = it.name;
        label.replaceWith(input);
        input.focus();
        input.select();
        const done = (ok) => {
            if (ok && input.value.trim()) { it.name = input.value.trim().slice(0, 24); saveItems(); }
            renderList();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter')  done(true);
            if (e.key === 'Escape') done(false);
        });
        input.addEventListener('blur', () => done(true));
        input.addEventListener('click', (e) => e.stopPropagation());
    }
    function rowOf(el) {
        const row = el.closest('li, tr, .list-group-item, [class*="-row"], [class*="-item"], [class*="-block"], .flex-container');
        if (!row || row === el) return '';
        return (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    }

    function stableCls(el) {
        return Array.from(el.classList)
            .filter(c => !/^(qp-|ui-|hover|dragging)/.test(c) && !STATE_CLS.test(c))
            .sort().join(' ');
    }

    function hostOf(el) {
        const b = el.closest('.inline-drawer, .drawer, [id*="settings"]');
        const h = b && (b.querySelector('b, .inline-drawer-toggle, h3, h4') || b);
        return h ? (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 35) : '';
    }

    function fingerprint(el) {
        const p = el.parentElement;
        // list: элемент кастомного списка — ищем его по тексту, а не по позиции,
        // потому что такие списки пересортировываются и перерисовываются целиком
        const list = !el.id && !el.matches(NATIVE_CLICKABLE) && !isToggleLike(el) && isListItem(el) && !!txtOf(el);
        return {
            tag: el.tagName,
            eid: el.id || '',
            aid: el.getAttribute('data-qp-id') || '',
            cls: stableCls(el),
            title: el.getAttribute('title') || '',
            txt: txtOf(el),
            row: list ? '' : rowOf(el),
            pos: p ? Array.from(p.children).indexOf(el) : -1,
            host: hostOf(el),
            list
        };
    }

    function fpScore(el, fp) {
        if (!el || !fp || el.nodeType !== 1) return -1;
        if (el.tagName !== fp.tag) return -1;
        if (fp.eid) return el.id === fp.eid ? 100 : -1;
        if (el.id) return -1;

        if (fp.cls && stableCls(el) !== fp.cls) return -1;
        const txt = txtOf(el);
        if (fp.list && fp.txt && txtKey(txt) !== txtKey(fp.txt)) return -1;
        if (fp.row && rowOf(el) !== fp.row) return -1;
        if (fp.host && hostOf(el) !== fp.host) return -1;

        let s = 0;
        if (fp.aid && el.getAttribute('data-qp-id') === fp.aid) s += 40;
        if (fp.cls) s += 25;
        if (fp.row) s += 30;
        if (fp.host) s += 15;
        const p = el.parentElement;
        if (fp.pos >= 0 && p && Array.from(p.children).indexOf(el) === fp.pos) s += 10;
        if (fp.title && el.getAttribute('title') === fp.title) s += 5;
        if (fp.txt && txt === fp.txt) s += 5;
        return s;
    }

    function fpMatch(el, fp) { return fpScore(el, fp) >= 0; }

    function describe(el) {
        const cls = Array.from(el.classList).slice(0, 2).join('.');
        const sig = sigOf(el);
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + ' | ' + sig;
    }

    function resolveItem(it) {
        if (it.ad) return null;
        if (!it.fp) {
            const g = safeQuery(it.sel);
            if (!g) return null;
            it.fp = fingerprint(g);
            if (!it.fp.aid) { it.fp.aid = it.id; }
            g.setAttribute('data-qp-id', it.fp.aid);
            saveItems();
        }
        if (it._el && it._el.isConnected && fpScore(it._el, it.fp) >= 0) return it._el;
        it._el = null;
        // Недавно уже искали и не нашли — не перебираем DOM на каждом тике
        if (it._missAt && Date.now() - it._missAt < 2000) return null;
        const found = resolveSlow(it);
        it._missAt = found ? 0 : Date.now();
        return found;
    }

    function resolveSlow(it) {
        let el;

        el = it.fp.aid ? document.querySelector('[data-qp-id="' + it.fp.aid + '"]') : null;
        if (el && el.isConnected && fpScore(el, it.fp) >= 0) { it._el = el; return el; }

        if (it.fp.eid) {
            el = document.getElementById(it.fp.eid);
            if (!el) return null;
            el.setAttribute('data-qp-id', it.fp.aid || it.id);
            it._el = el;
            return el;
        }

        el = safeQuery(it.sel);
        if (el) {
            const score = fpScore(el, it.fp);
            if (score >= 0) {
                el.setAttribute('data-qp-id', it.fp.aid || it.id);
                it._el = el;
                return el;
            }
            // Отпечаток не совпал, но селектор нашёл элемент — переснимаем отпечаток.
            // Для элементов списка так делать нельзя: по позиции там уже лежит
            // ДРУГАЯ карточка (список пересортировался), ищем дальше по тексту.
            if (!it.fp.list) {
                it.fp = fingerprint(el);
                if (!it.fp.aid) it.fp.aid = it.id;
                el.setAttribute('data-qp-id', it.fp.aid);
                it._el = el;
                saveItems();
                return el;
            }
        }

        const cands = [];
        if (it.fp.cls) {
            try { cands.push(...document.querySelectorAll(it.fp.tag.toLowerCase() + '.' + it.fp.cls.split(' ').map(esc).join('.'))); } catch (e) {}
        }
        // Полный перебор всех кликабельных элементов страницы — дорого, только если класса нет
        if (!it.fp.cls) cands.push(...document.querySelectorAll(INTERACTIVE));
        let best = null, bestScore = -1;
        for (const c of cands) {
            const s = fpScore(c, it.fp);
            if (s > bestScore) { bestScore = s; best = c; if (s >= 90) break; }
        }
        if (best && bestScore >= 0) {
            best.setAttribute('data-qp-id', it.fp.aid || it.id);
            it.sel = selectorFor(best);
            it._el = best;
            saveItems();
            return best;
        }
        return null;
    }


    function safeQuery(sel) {
        try { return document.querySelector(sel); } catch (e) { return null; }
    }

    const MARK_SEL = '[class*="toggle-on"], [class*="toggle-off"], [class*="toggle_on"], [class*="toggle_off"], .fa-toggle-on, .fa-toggle-off';

    // Элемент спрятан сам по себе (не считая скрытых предков)
    function ownHidden(el) {
        try {
            const s = getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') return true;
            if (parseFloat(s.opacity) === 0) return true;
        } catch (e) {}
        return /(^|\s)(displayNone|hidden|hide|is-hidden|d-none)(\s|$)/.test(String(el.className || ''));
    }

    // Виджеты вроде ExtBlocks держат в одном label два span'а — toggle-on и toggle-off —
    // и прячут один. Класс никогда не меняется, меняется только видимость.
    // Возвращаем тот маркер, который сейчас показан.
    // ВАЖНО: срабатывает ТОЛЬКО для ExtBlocks, иначе ломает обычные чекбоксы таверны.
    function markerPair(t) {
        const scope = t.closest('label') || t.parentElement;
        if (!scope) return null;

        // Проверка: это ExtBlocks или обычный label?
        const scopeCls = String(scope.className || '');
        const tCls = String(t.className || '');
        const isExtBlocks = /ExtBlocks/i.test(scopeCls) || /ExtBlocks/i.test(tCls);

        let marks;
        try { marks = Array.from(scope.querySelectorAll(MARK_SEL)); } catch (e) { return null; }
        if (t.matches && t.matches(MARK_SEL) && marks.indexOf(t) < 0) marks.push(t);
        if (marks.length < 2) return null;

        // Если это НЕ ExtBlocks, проверяем классы маркеров — может быть другой похожий виджет
        if (!isExtBlocks) {
            const hasPair = marks.some(m => /toggle[-_](on|off)/i.test(String(m.className || '')));
            if (!hasPair) return null; // обычный label с иконками — не наш случай
        }

        const shown = marks.filter(m => !ownHidden(m));
        return shown.length === 1 ? shown[0] : null;
    }

    function stateNode(t) {
        if (t.matches('input[type=checkbox], input[type=radio]')) return t;
        const pair = markerPair(t);
        if (pair) return pair;
        if (t.matches(MARK_SEL)) return t;
        const scope = t.closest('label') || t;
        const marked = scope.querySelector(MARK_SEL);
        if (marked) return marked;
        const inp = scope.querySelector('input[type=checkbox], input[type=radio]');
        if (inp) return inp;
        return t;
    }

    function sigOf(t) {
        const n = stateNode(t);
        if (n.matches && n.matches('input[type=checkbox], input[type=radio]')) return 'chk:' + (n.checked ? 1 : 0);
        return 'cls:' + Array.from(n.classList).filter(c => !/^(qp-|hover|dragging)/.test(c)).sort().join(' ');
    }

    function guessOn(sig) {
        if (sig.indexOf('chk:') === 0) return sig === 'chk:1';
        const raw = sig.slice(4);
        if (/toggle[-_]?on\b/i.test(raw)) return true;
        if (/toggle[-_]?off\b/i.test(raw)) return false;
        const s = ' ' + raw.replace(/[-_]/g, ' ').toLowerCase() + ' ';
        if (/ (off|disabled|disable|inactive|closed|hidden|false|no) /.test(s)) return false;
        if (/ (on|enabled|enable|active|checked|open|opened|shown|true|yes) /.test(s)) return true;
        return null;
    }

    function stateOf(it, t) {
        if (!t || isDrawerHead(t)) return 'none';
        const sig = sigOf(t);
        let on = guessOn(sig);
        if (on === null && it.sigOn) on = (sig === it.sigOn);
        else if (on === null && it.sigOff) on = (sig !== it.sigOff);
        if (on === null && it.fp && it.fp.list) on = false; // карточка без active-класса = не выбрана
        if (on === null) return 'unknown';
        return (it.inv ? !on : on) ? 'on' : 'off';
    }

    function learnSig(it, before, after) {
        if (!before || !after || before === after) return;
        if (guessOn(after) !== null) return;
        it.sigOff = before; it.sigOn = after; saveItems();
    }

    function syncStates() {
        if (!listEl || !panel.classList.contains('qp-open') || document.hidden) return;
        listEl.querySelectorAll('.qp-chip[data-qp-item-id]').forEach((chip) => {
            const it = items.find(x => x.id === chip.dataset.qpItemId);
            if (!it) return;
            if (it.ad) {
                const st = adState(it);
                chip.classList.toggle('qp-missing', st === 'missing');
                chip.classList.add('qp-tgl');
                chip.classList.toggle('qp-on', st === 'on');
                chip.classList.remove('qp-unknown');
                return;
            }
            const t = resolveItem(it);
            chip.classList.toggle('qp-missing', !t);

            const st = stateOf(it, t);
            chip.classList.toggle('qp-tgl', st !== 'none');
            chip.classList.toggle('qp-on', st === 'on');
            chip.classList.toggle('qp-unknown', st === 'unknown');
        });
    }

    let mo = null, lastSync = 0, syncPend = null;
    function requestSync() {
        const now = Date.now();
        if (now - lastSync > 350) { lastSync = now; syncStates(); return; }
        if (syncPend) return;
        syncPend = setTimeout(() => { syncPend = null; lastSync = Date.now(); syncStates(); }, 350);
    }
    function startWatch() {
        if (mo) return;
        mo = new MutationObserver((muts) => {
            for (const m of muts) {
                const t = m.target;
                if (t && t.closest && (t.closest(OWN) || t.closest('#chat'))) continue;
                requestSync();
                return;
            }
        });
        mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'checked'] });
    }
    function stopWatch() { if (mo) { mo.disconnect(); mo = null; } }

    function placePanel(ignoreSaved) {
        const box = ignoreSaved ? null : lsGet(boxKey(), null);
        if (isMobile()) {
            const defW = Math.min(220, Math.round(window.innerWidth * 0.62));
            panel.style.width = (box && typeof box.width === 'number')
                ? clamp(box.width, 150, window.innerWidth - 16) + 'px'
                : defW + 'px';
            panel.style.height = (box && typeof box.height === 'number')
                ? clamp(box.height, 140, window.innerHeight - 16) + 'px'
                : (panel.style.height || '260px');
            const pw = panel.offsetWidth || defW, ph = panel.offsetHeight || 260;
            if (box && typeof box.left === 'number') {
                panel.style.left = clamp(box.left, 4, Math.max(4, window.innerWidth - pw - 4)) + 'px';
                panel.style.top  = clamp(box.top,  4, Math.max(4, window.innerHeight - ph - 4)) + 'px';
            } else {
                panel.style.left = Math.round((window.innerWidth - pw) / 2) + 'px';
                panel.style.top  = Math.round(window.innerHeight * 0.22) + 'px';
            }
            return;
        }
        const w = panel.offsetWidth || 200;
        const h = panel.offsetHeight || 230;
        if (box && typeof box.left === 'number') {
            panel.style.left = clamp(box.left, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
            panel.style.top  = clamp(box.top,  8, Math.max(8, window.innerHeight - h - 8)) + 'px';
            return;
        }
        panel.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
        panel.style.top  = Math.round((window.innerHeight - h) / 2) + 'px';
    }

    function saveBox() {
        if (!panel) return;
        lsSet(boxKey(), { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight });
    }

function openPanel() {
    if (!panel) buildPanel();
        panel.classList.add('qp-open');
        requestAnimationFrame(() => placePanel(false));
        renderList();
        startWatch();
        clearInterval(tickTimer);
        tickTimer = setInterval(syncStates, 2000);
    }
    function closePanel() {
        if (panel && panel.classList.contains('qp-open')) saveBox();
        if (panel) panel.classList.remove('qp-open');
        clearInterval(tickTimer);
        stopWatch();
        stopPick();
    }
    
    function togglePanel() {
        if (panel && panel.classList.contains('qp-open')) closePanel(); else openPanel();
    }

    /* ---------------- DRAG / RESIZE ---------------- */

    function makeDraggable(el, handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, act = false, moved = false, id = null;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.qp-ico')) return;
            act = true; moved = false; id = e.pointerId;
            sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop;
            handle.setPointerCapture(id);
        });
        handle.addEventListener('pointermove', (e) => {
            if (!act || e.pointerId !== id) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            if (!moved) { moved = true; document.body.classList.add('qp-dragging'); }
            e.preventDefault();
            el.style.left = clamp(ox + dx, 0, window.innerWidth  - el.offsetWidth)  + 'px';
            el.style.top  = clamp(oy + dy, 0, window.innerHeight - el.offsetHeight) + 'px';
        });
        const end = () => {
            if (!act) return;
            act = false;
            document.body.classList.remove('qp-dragging');
            if (moved) saveBox();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function makeResizable(el, grip) {
        let sx = 0, sy = 0, sw = 0, sh = 0, act = false, id = null;
        grip.addEventListener('pointerdown', (e) => {
            if (el.classList.contains('qp-pinned')) return;
            act = true; id = e.pointerId;
            sx = e.clientX; sy = e.clientY; sw = el.offsetWidth; sh = el.offsetHeight;
            grip.setPointerCapture(id);
            document.body.classList.add('qp-dragging');
            e.preventDefault();
        });
        grip.addEventListener('pointermove', (e) => {
            if (!act || e.pointerId !== id) return;
            el.style.width  = clamp(sw + (e.clientX - sx), 150, window.innerWidth  - el.offsetLeft) + 'px';
            el.style.height = clamp(sh + (e.clientY - sy), 140, window.innerHeight - el.offsetTop)  + 'px';
        });
        const end = () => {
            if (!act) return;
            act = false;
            document.body.classList.remove('qp-dragging');
            saveBox();
        };
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    }

    /* ---------------- ПЛАВАЮЩАЯ КНОПКА ---------------- */

    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.title = 'Быстрая панель (зажми чтобы добавить элемент)';
    btn.innerHTML = '<i class="fa-solid fa-bolt"></i>';
    document.body.appendChild(btn);
    ['pointerdown', 'mousedown', 'click', 'touchstart'].forEach(ev =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));

    (function restoreBtn() {
        const saved = lsGet(LS_BTNPOS, null);
        const w = btn.offsetWidth || 34, h = btn.offsetHeight || 34;
        let left = saved && typeof saved.left === 'number' ? saved.left : window.innerWidth - w - 14;
        let top  = saved && typeof saved.top  === 'number' ? saved.top  : Math.round(window.innerHeight * 0.5);
        btn.style.left = clamp(left, 4, window.innerWidth - w - 4) + 'px';
        btn.style.top  = clamp(top,  4, window.innerHeight - h - 4) + 'px';
    })();

    (function btnInteraction() {
        let sx = 0, sy = 0, ox = 0, oy = 0, down = false, moved = false, id = null, longTimer = null;
        btn.addEventListener('pointerdown', (e) => {
            down = true; moved = false; id = e.pointerId;
            sx = e.clientX; sy = e.clientY; ox = btn.offsetLeft; oy = btn.offsetTop;
            btn.setPointerCapture(id);
            btn.classList.add('qp-press');
            longTimer = setTimeout(() => {
                if (down && !moved) {
                    longTimer = null;
                    startPick();
                }
            }, LONGPRESS_MS);
        });
        btn.addEventListener('pointermove', (e) => {
            if (!down || e.pointerId !== id) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            moved = true;
            clearTimeout(longTimer);
            e.preventDefault();
            btn.style.left = clamp(ox + dx, 4, window.innerWidth  - btn.offsetWidth  - 4) + 'px';
            btn.style.top  = clamp(oy + dy, 4, window.innerHeight - btn.offsetHeight - 4) + 'px';
        });
        btn.addEventListener('pointerup', (e) => {
            if (!down || e.pointerId !== id) return;
            down = false;
            clearTimeout(longTimer);
            btn.classList.remove('qp-press');
            if (moved) lsSet(LS_BTNPOS, { left: btn.offsetLeft, top: btn.offsetTop });
            else if (!picking) togglePanel();
        });
        btn.addEventListener('pointercancel', () => { down = false; clearTimeout(longTimer); btn.classList.remove('qp-press'); });
    })();

    function applyFloat() {
        btn.classList.toggle('qp-hidden', !cfg.float);
        if (!cfg.float) closePanel();
    }

    /* ---------------- ВНЕШНИЙ ВИД: иконка и акцентный цвет ---------------- */

    // Только бесплатные solid-иконки Font Awesome 6
    const ICONS = [
        'fa-bolt', 'fa-bolt-lightning', 'fa-circle-check', 'fa-star', 'fa-heart', 'fa-fire',
        'fa-fire-flame-curved', 'fa-wand-magic-sparkles', 'fa-wand-sparkles', 'fa-hat-wizard', 'fa-gem', 'fa-crown',
        'fa-dragon', 'fa-ghost', 'fa-skull', 'fa-cat', 'fa-paw', 'fa-crow',
        'fa-dove', 'fa-frog', 'fa-otter', 'fa-kiwi-bird', 'fa-spider', 'fa-fish',
        'fa-feather', 'fa-leaf', 'fa-seedling', 'fa-moon', 'fa-sun', 'fa-snowflake',
        'fa-meteor', 'fa-rocket', 'fa-user-astronaut', 'fa-robot', 'fa-atom', 'fa-brain',
        'fa-eye', 'fa-yin-yang', 'fa-infinity', 'fa-dice-d20', 'fa-gamepad', 'fa-puzzle-piece',
        'fa-music', 'fa-palette', 'fa-mug-hot', 'fa-compass', 'fa-sliders', 'fa-layer-group'
    ];

    // Цвета берутся из текущей темы таверны (User Settings → UI Theme)
    const ACCENTS = {
        quote:     { label: 'Цитаты',        v: '--SmartThemeQuoteColor' },
        em:        { label: 'Курсив',        v: '--SmartThemeEmColor' },
        underline: { label: 'Подчёркивание', v: '--SmartThemeUnderlineColor' },
        body:      { label: 'Текст',         v: '--SmartThemeBodyColor' },
        custom:    { label: 'Свой',          v: '' }
    };

    const cleanIcon = (v) => {
        const m = String(v || '').match(/fa-(?!solid|regular|brands|fw|lg|xl|2x)[a-z0-9-]+/g);
        return m ? m[m.length - 1] : '';
    };

    function applyLook() {
        const ic = cleanIcon(cfg.icon) || 'fa-bolt';
        const bi = btn.querySelector('i');
        if (bi) bi.className = 'fa-solid ' + ic;
        const wd = document.querySelector('#qp-wand .extensionsMenuExtensionButton');
        if (wd) wd.className = 'fa-solid ' + ic + ' extensionsMenuExtensionButton';

        const a = ACCENTS[cfg.accent] || ACCENTS.quote;
        const val = cfg.accent === 'custom'
            ? (/^#[0-9a-f]{6}$/i.test(cfg.accentColor) ? cfg.accentColor : '#6aa9ff')
            : 'var(' + a.v + ', #6aa9ff)';
        document.documentElement.style.setProperty('--qp-accent', val);
    }

    /* ---------------- ПУНКТ В МЕНЮ ПАЛОЧКИ ---------------- */

    function mountWand() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        let item = document.getElementById('qp-wand');
        if (!item) {
            item = document.createElement('div');
            item.id = 'qp-wand';
            item.className = 'list-group-item flex-container flexGap5 interactable';
            item.tabIndex = 0;
            item.innerHTML = '<div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span>Быстрая панель</span>';
            item.addEventListener('click', () => togglePanel());
            menu.appendChild(item);
        }
        item.classList.toggle('qp-hidden', !cfg.wand);
        applyLook();
        return true;
    }

    /* ---------------- НАСТРОЙКИ ---------------- */

function buildSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return false;
    if (document.getElementById('qp-settings')) return true;

        const block = document.createElement('div');
        block.id = 'qp-settings';
        block.className = 'inline-drawer';

        const head = document.createElement('div');
        head.className = 'inline-drawer-toggle inline-drawer-header qp-set-head';
        head.innerHTML = '<b>Быстрая панель</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>';

        const body = document.createElement('div');
        body.className = 'inline-drawer-content';
        const inner = document.createElement('div');
        inner.className = 'qp-set-inner';

        // Свой тоггл без <input> и <label>. Переключается только прямым
        // кликом по себе — нативной связки label→input больше не существует,
        // поэтому чужие клики и всплытие до него физически не доберутся.
        const mkCheck = (id, text, get, set) => {
            const l = document.createElement('div');
            l.className = 'qp-check';
            l.id = id;
            l.tabIndex = 0;
            l.setAttribute('role', 'checkbox');

            const box = document.createElement('span');
            box.className = 'qp-check-box';
            box.innerHTML = '<i class="fa-solid fa-check"></i>';

            const s = document.createElement('span');
            s.className = 'qp-check-lb';
            s.textContent = text;

            l.append(box, s);

            const sync = () => {
                const on = !!get();
                l.classList.toggle('qp-check-on', on);
                l.setAttribute('aria-checked', on ? 'true' : 'false');
            };

            const flip = (e) => {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                set(!get());
                sync();
            };

            l.addEventListener('click', flip);
            l.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') flip(e);
            });

            sync();
            return { label: l, sync };
        };

        const cFloat = mkCheck('qp-cfg-float', 'Плавающая кнопка',
            () => cfg.float,
            (v) => { cfg.float = v; saveCfg(); applyFloat(); }
        );
        const cWand = mkCheck('qp-cfg-wand', 'Пункт в меню палочки',
            () => cfg.wand,
            (v) => { cfg.wand = v; saveCfg(); mountWand(); }
        );

        const row = document.createElement('div');
        row.className = 'qp-set-row';
        const bOpen  = document.createElement('div');
        bOpen.className = 'menu_button menu_button_icon';
        bOpen.textContent = 'Открыть/закрыть панель';
        const bPick  = document.createElement('div');
        bPick.className = 'menu_button menu_button_icon';
        bPick.textContent = 'Добавить элемент';
        const bReset = document.createElement('div');
        bReset.className = 'menu_button menu_button_icon';
        bReset.textContent = 'Сбросить положение';
        const bClear = document.createElement('div');
        bClear.className = 'menu_button menu_button_icon qp-danger';
        bClear.textContent = 'Очистить список';
        row.append(bOpen, bPick, bReset, bClear);

        const hint = document.createElement('small');
        hint.className = 'qp-set-hint';
        hint.textContent = 'Включи прицел и кликни по кнопке или тоглу. Корзинка — удалить. Карандаш — переименование; в этом режиме зажми чип или папку и перетащи (мышью — просто тяни). Двойной клик по шапке — сброс размера.';

        // Свёрнутый подраздел: содержимое строится при первом открытии
        const mkSection = (title, previewFn, build) => {
            const sec = document.createElement('div');
            sec.className = 'qp-sub';
            const head = document.createElement('div');
            head.className = 'qp-sub-head';
            head.innerHTML = '<i class="fa-solid fa-chevron-right qp-sub-arrow"></i><span class="qp-sub-title"></span><span class="qp-sub-prev"></span>';
            head.querySelector('.qp-sub-title').textContent = title;
            const prev = head.querySelector('.qp-sub-prev');
            const body = document.createElement('div');
            body.className = 'qp-sub-body';
            let built = false;
            const refreshPrev = () => previewFn(prev);
            head.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                if (!built) { build(body, refreshPrev); built = true; }
                sec.classList.toggle('qp-sub-open');
            });
            refreshPrev();
            sec.append(head, body);
            return sec;
        };

        const icoBlock = mkSection('Иконка кнопки',
            (p) => { p.innerHTML = '<i class="fa-solid ' + (cleanIcon(cfg.icon) || 'fa-bolt') + '"></i>'; },
            (body, refreshPrev) => {
                const grid = document.createElement('div');
                grid.className = 'qp-ico-grid';
                grid.innerHTML = ICONS.map(n =>
                    '<div class="qp-ico-opt" data-ico="' + n + '" title="' + n.slice(3) + '"><i class="fa-solid ' + n + '"></i></div>'
                ).join('');
                const mark = () => {
                    const cur = cleanIcon(cfg.icon) || 'fa-bolt';
                    const old = grid.querySelector('.qp-sel');
                    if (old) old.classList.remove('qp-sel');
                    const now = grid.querySelector('[data-ico="' + cur + '"]');
                    if (now) now.classList.add('qp-sel');
                };
                grid.addEventListener('click', (e) => {
                    const o = e.target.closest('.qp-ico-opt');
                    if (!o) return;
                    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                    cfg.icon = o.dataset.ico; saveCfg(); applyLook(); mark(); refreshPrev();
                });
                body.appendChild(grid);
                mark();
            });

        const accBlock = mkSection('Цвет иконки и контура',
            (p) => { p.innerHTML = '<span class="qp-acc-sw" style="background: var(--qp-accent)"></span>'; },
            (body) => {
                const accRow = document.createElement('div');
                accRow.className = 'qp-acc-row';
                const picker = document.createElement('input');
                picker.type = 'color';
                picker.className = 'qp-acc-picker';
                picker.value = /^#[0-9a-f]{6}$/i.test(cfg.accentColor) ? cfg.accentColor : '#6aa9ff';
                const mark = () => {
                    accRow.querySelectorAll('.qp-acc-opt').forEach(o => o.classList.toggle('qp-sel', o.dataset.acc === cfg.accent));
                    picker.classList.toggle('qp-hidden', cfg.accent !== 'custom');
                };
                Object.entries(ACCENTS).forEach(([key, a]) => {
                    const o = document.createElement('div');
                    o.className = 'qp-acc-opt';
                    o.dataset.acc = key;
                    const sw = document.createElement('span');
                    sw.className = 'qp-acc-sw';
                    sw.style.background = key === 'custom'
                        ? 'conic-gradient(#ff6b6b, #ffd93d, #6bcb77, #4d96ff, #c77dff, #ff6b6b)'
                        : 'var(' + a.v + ')';
                    const lb = document.createElement('span');
                    lb.textContent = a.label;
                    o.append(sw, lb);
                    o.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                        cfg.accent = key; saveCfg(); applyLook(); mark();
                    });
                    accRow.appendChild(o);
                });
                ['pointerdown', 'click'].forEach(ev => picker.addEventListener(ev, e => e.stopPropagation()));
                // пока тянешь по палитре — только перекрашиваем, сохраняем по отпусканию
                picker.addEventListener('input', () => { cfg.accentColor = picker.value; applyLook(); });
                picker.addEventListener('change', () => { cfg.accentColor = picker.value; saveCfg(); });
                accRow.appendChild(picker);
                const cap = document.createElement('small');
                cap.className = 'qp-set-hint';
                cap.textContent = 'Цвет берётся из темы таверны и меняется вместе с ней.';
                body.append(accRow, cap);
                mark();
            });

        inner.append(cFloat.label, cWand.label, icoBlock, accBlock, row, hint);
        body.appendChild(inner);
        block.append(head, body);
        host.appendChild(block);

        head.addEventListener('click', (e) => {
            e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
            block.classList.toggle('qp-set-open');
        }, true);

        const syncChecks = () => { cFloat.sync(); cWand.sync(); };
        const guard = (fn) => (e) => {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            fn();
            syncChecks();
            setTimeout(syncChecks, 0);
            setTimeout(syncChecks, 120);
        };

        bOpen.addEventListener('click', guard(() => togglePanel()));
        bPick.addEventListener('click', guard(() => startPick()));
        bReset.addEventListener('click', guard(() => {
            try { localStorage.removeItem(LS_BTNPOS); localStorage.removeItem(LS_BOX_D); localStorage.removeItem(LS_BOX_M); } catch (e) {}
            const w = btn.offsetWidth || 34;
            btn.style.left = (window.innerWidth - w - 14) + 'px';
            btn.style.top  = Math.round(window.innerHeight * 0.5) + 'px';
            if (panel) { panel.style.width = '200px'; panel.style.height = '230px'; requestAnimationFrame(() => placePanel(true)); }
        }));
        bClear.addEventListener('click', guard(() => {
            items = []; saveItems(); renderList(); toast('Список очищен');
        }));

    return true;
}


    /* ---------------- СТАРТ ---------------- */

    applyFloat();
    applyLook();

    window.addEventListener('resize', () => {
        const w = btn.offsetWidth, h = btn.offsetHeight;
        if (btn.offsetLeft > window.innerWidth - w - 4 || btn.offsetTop > window.innerHeight - h - 4) {
            btn.style.left = clamp(btn.offsetLeft, 4, window.innerWidth - w - 4) + 'px';
            btn.style.top  = clamp(btn.offsetTop,  4, window.innerHeight - h - 4) + 'px';
        }
        if (panel && panel.classList.contains('qp-open')) {
            const pw = panel.offsetWidth, ph = panel.offsetHeight;
            if (panel.offsetLeft > window.innerWidth - pw - 4 || panel.offsetTop > window.innerHeight - ph - 4) {
                panel.style.left = clamp(panel.offsetLeft, 4, Math.max(4, window.innerWidth  - pw - 4)) + 'px';
                panel.style.top  = clamp(panel.offsetTop,  4, Math.max(4, window.innerHeight - ph - 4)) + 'px';
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && picking) stopPick();
        else if (e.key === 'Escape') closePanel();
    });

    (function waitHosts() {
        let tries = 0;
        const iv = setInterval(() => {
            const a = buildSettings();
            const b = mountWand();
            if ((a && b) || ++tries > 80) clearInterval(iv);
        }, 500);
    })();
})();
