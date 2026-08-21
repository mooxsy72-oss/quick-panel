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
   
    let cfg   = Object.assign({ float: true, wand: true }, lsGet(LS_CFG, {}));

    const saveItems   = () => lsSet(LS_ITEMS, items.map(({ _el, ...rest }) => rest));
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
        const r = hit.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.85 && r.height > window.innerHeight * 0.5) return null;
        if (hit.tagName === 'LABEL') {
            const i = hit.querySelector('input');
            if (i) return i;
        }
        return hit;
    }

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

        // 3. Всё остальное — клик по выбранному элементу.
        //    Никакого всплытия к предкам: именно оно било по #extensions-settings-button
        //    и дёргало чужие чекбоксы вместо нужной кнопки.
        el.click();
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

    function addItem(el) {
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
                <span class="qp-title"><i class="fa-solid fa-bolt"></i> Панель</span>
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
            panel.classList.toggle('qp-editing');
            renderList();
        });

        panel.querySelector('.qp-head').addEventListener('dblclick', (e) => {
            if (e.target.closest('.qp-ico')) return;
            if (panel.classList.contains('qp-pinned')) return;
            try { localStorage.removeItem(boxKey()); } catch (err) {}
            panel.style.width = '190px';
            panel.style.height = '230px';
            requestAnimationFrame(() => placePanel(true));
        });

        makeDraggable(panel, panel.querySelector('.qp-head'));
        makeResizable(panel, panel.querySelector('.qp-grip'));
        renderList();
    }

    // Перемещает it на позицию dir (-1/+1) относительно соседей ВНУТРИ ЕГО ЖЕ ПАПКИ,
    // а не по глобальному индексу — иначе "выше/ниже" перепрыгивало бы между папками.
    function moveItem(it, dir) {
        const group = items.filter(x => (x.folder || '') === (it.folder || ''));
        const gi = group.indexOf(it);
        const ni = gi + dir;
        if (ni < 0 || ni >= group.length) return;
        const other = group[ni];
        const ai = items.indexOf(it), bi = items.indexOf(other);
        items[ai] = other; items[bi] = it;
        saveItems(); renderList();
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

        head.addEventListener('click', (e) => {
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
        const chip = document.createElement('div');
        chip.className = 'qp-chip' + (target ? '' : ' qp-missing') + (it.folder ? ' qp-chip-nested' : '');
        chip.dataset.qpItemId = it.id;
        chip.title = target ? it.name : 'Элемент не найден на странице';
        const dot = document.createElement('span');
        dot.className = 'qp-chip-dot';
        const ic = document.createElement('i');
        ic.className = it.icon + ' qp-chip-ic';
        const label = document.createElement('span');
        label.className = 'qp-chip-lb';
        label.textContent = it.name;
        chip.append(dot, ic, label);

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
            '<i class="fa-solid fa-arrow-up qp-t qp-up" title="Выше"></i>' +
            '<i class="fa-solid fa-arrow-down qp-t qp-dn" title="Ниже"></i>' +
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
        tools.appendChild(folderSel);
        chip.appendChild(tools);

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
            if (e.target.closest('.qp-chip-del')) {
                items.splice(items.indexOf(it), 1); saveItems(); renderList(); return;
            }
            if (panel.classList.contains('qp-editing')) {
                if (e.target.closest('.qp-up'))  { moveItem(it, -1); return; }
                if (e.target.closest('.qp-dn'))  { moveItem(it, 1);  return; }
                if (e.target.closest('.qp-inv')) { it.inv = !it.inv; saveItems(); syncStates(); toast(it.inv ? 'Индикатор перевёрнут' : 'Индикатор как есть'); return; }
                if (e.target.closest('.qp-info')) { const t = resolveItem(it); toast(t ? describe(t) : 'Элемент не найден'); return; }
                if (e.target.closest('.qp-chip-folder-sel')) return;
                if (chip.classList.contains('qp-has-sel')) return;
                startRename(chip, label, it);
                return;
            }
            if (chip.classList.contains('qp-has-sel')) return;
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
        return {
            tag: el.tagName,
            eid: el.id || '',
            aid: el.getAttribute('data-qp-id') || '',
            cls: stableCls(el),
            title: el.getAttribute('title') || '',
            txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
            row: rowOf(el),
            pos: p ? Array.from(p.children).indexOf(el) : -1,
            host: hostOf(el)
        };
    }

    function fpScore(el, fp) {
        if (!el || !fp || el.nodeType !== 1) return -1;
        if (el.tagName !== fp.tag) return -1;
        if (fp.eid) return el.id === fp.eid ? 100 : -1;
        if (el.id) return -1;

        if (fp.cls && stableCls(el) !== fp.cls) return -1;
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
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
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

        let el = it.fp.aid ? document.querySelector('[data-qp-id="' + it.fp.aid + '"]') : null;
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
            // Отпечаток не совпал, но селектор нашёл элемент — переснимаем отпечаток
            it.fp = fingerprint(el);
            if (!it.fp.aid) it.fp.aid = it.id;
            el.setAttribute('data-qp-id', it.fp.aid);
            it._el = el;
            saveItems();
            return el;
        }


        let best = null, bestScore = -1;
        for (const c of document.querySelectorAll(INTERACTIVE)) {
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
        if (on === null) return 'unknown';
        return (it.inv ? !on : on) ? 'on' : 'off';
    }

    function learnSig(it, before, after) {
        if (!before || !after || before === after) return;
        if (guessOn(after) !== null) return;
        it.sigOff = before; it.sigOn = after; saveItems();
    }

    function syncStates() {
        if (!listEl) return;
        listEl.querySelectorAll('.qp-chip[data-qp-item-id]').forEach((chip) => {
            const it = items.find(x => x.id === chip.dataset.qpItemId);
            if (!it) return;
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
        if (now - lastSync > 220) { lastSync = now; syncStates(); return; }
        if (syncPend) return;
        syncPend = setTimeout(() => { syncPend = null; lastSync = Date.now(); syncStates(); }, 220);
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
        const w = panel.offsetWidth || 190;
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
        tickTimer = setInterval(syncStates, 1200);
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
        const w = btn.offsetWidth || 42, h = btn.offsetHeight || 42;
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
        hint.textContent = 'Включи прицел и кликни по кнопке или тоглу. Корзинка — удалить. Карандаш — переименование и порядок. Двойной клик по шапке — сброс размера.';

        inner.append(cFloat.label, cWand.label, row, hint);
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
            const w = btn.offsetWidth || 42;
            btn.style.left = (window.innerWidth - w - 14) + 'px';
            btn.style.top  = Math.round(window.innerHeight * 0.5) + 'px';
            if (panel) { panel.style.width = '190px'; panel.style.height = '230px'; requestAnimationFrame(() => placePanel(true)); }
        }));
        bClear.addEventListener('click', guard(() => {
            items = []; saveItems(); renderList(); toast('Список очищен');
        }));

    return true;
}


    /* ---------------- СТАРТ ---------------- */

    applyFloat();

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
