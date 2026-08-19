(function () {
    'use strict';

    const BTN_ID    = 'qp-btn';
    const PANEL_ID  = 'qp-panel';
    const LS_ITEMS  = 'qpItems';
    const LS_BTNPOS = 'qpBtnPos';
    const LS_BOX    = 'qpPanelBox';
    const LS_CFG    = 'qpConfig';
    const DRAG_THRESHOLD = 8;
    const LONGPRESS_MS = 500;
    const OWN = '#qp-panel, #qp-btn, #qp-hl, #qp-toast, #qp-settings';

    const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

    function lsGet(k, def) {
        try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? def : v; }
        catch (e) { return def; }
    }
    function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

    let items = lsGet(LS_ITEMS, []);
    let cfg   = Object.assign({ float: true, wand: true }, lsGet(LS_CFG, {}));

    const saveItems = () => lsSet(LS_ITEMS, items);
    const saveCfg   = () => lsSet(LS_CFG, cfg);

    /* ---------------- СЕЛЕКТОРЫ ---------------- */

    const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');

    const STATE_CLS = /(^|[-_])(disabled|enabled|active|selected|checked|open|closed|down|up|on|off|lock|unlock|flash|hover)([-_]|$)|openIcon|closedIcon|displayNone|toggleEnabled|openDrawer|closedDrawer|drawer-content|flex(?![-_])/i;
    const KEY_ATTRS = ['data-pm-identifier', 'data-pm-prompt-id', 'data-id', 'uid', 'name'];

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

    const INTERACTIVE = 'input, select, button, a, [role="button"], .menu_button, .interactable, .list-group-item, label, .inline-drawer-toggle, .drawer-toggle, .inline-drawer-header, .right_menu_button, .extensionsMenuExtensionButton, i[class*="fa-"], span[class*="fa-"], [onclick], .clickable, .toggleEnabled, [class*="toggle"], [class*="header"], [class*="tab"], h3, h4, h5';

    function findInteractive(el) {
        if (!el || !el.closest) return null;
        // Приоритет: кнопка с id важнее обёртки
        let hit = el.closest('button, input, select, a, .menu_button, .inline-drawer-toggle, .drawer-toggle, .inline-drawer-header, h3, h4, h5, [class*="section-toggle"], [class*="section_toggle"]')
               || el.closest(INTERACTIVE);
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
    function openLorebook(it, done) {
        const content = document.querySelector('#WorldInfo');
        const drawerBtn = document.querySelector('#WI-SP-button .drawer-toggle')
                       || document.querySelector('#WI-SP-button');
        let wait = 0;
        if (content && !isVisible(content) && drawerBtn) { drawerBtn.click(); wait = 350; }
        setTimeout(() => {
            const ws = document.querySelector('#world_editor_select');
            let wait2 = 0;
            if (ws && it.wi !== undefined && ws.value !== it.wi) {
                ws.value = it.wi;
                ws.dispatchEvent(new Event('change', { bubbles: true }));
                try { if (window.jQuery) jQuery(ws).trigger('change'); } catch (e) {}
                wait2 = 650; // лорбуку нужно время на загрузку записей
            }
            setTimeout(done, wait2);
        }, wait);
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
        // 1. Тоглы и чекбоксы — тихий клик, ничего не открываем
        if (isToggleLike(el)) { el.click(); return; }

        // 2. Заголовок дровера/сайдбара — сначала раскрываем скрытых предков,
        //    чтобы развёрнутое содержимое было видно, потом кликаем заголовок
        const head = isDrawerHead(el) ? el : el.closest('.inline-drawer-toggle, .drawer-toggle');
        if (head) {
            const opened = revealParents(head);
            if (opened.length) setTimeout(() => head.click(), 300);
            else head.click();
            return;
        }

        // 3. Любая другая кнопка — просто клик. Обработчик срабатывает и для
        //    скрытого элемента, поэтому открывать/закрывать панели не нужно.
        //    Именно лишняя навигация и давала это мигание сайдбара.
        el.click();
    }

    function resolveItem(it) {
        let el = safeQuery(it.sel);
        if (el) return el;

        // Приоритет: uid (лорбук)
        if (it.uid) {
            el = document.querySelector(`[uid="${it.uid}"]`);
            if (el) { it.sel = selectorFor(el); saveItems(); return el; }
        }

        const all = document.querySelectorAll(INTERACTIVE);
        if (it.title) {
            for (const c of all) if (c.getAttribute('title') === it.title) { el = c; break; }
        }
        if (!el && it.txt) {
            for (const c of all) {
                if ((c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) === it.txt) { el = c; break; }
            }
        }
        if (!el && it.name) {
            for (const c of all) {
                if (nameFor(c) === it.name) { el = c; break; }
            }
        }
        if (el) { it.sel = selectorFor(el); saveItems(); }
        return el;
    }

    /* ---------------- ТОСТ ---------------- */

    let toastEl = null, toastTimer = null;
    function toast(text) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'qp-toast';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.classList.add('qp-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('qp-show'), 1800);
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
            hl.innerHTML = '<span class="qp-hl-tag"></span>';
            document.body.appendChild(hl);
        }
        hl.classList.add('qp-show');
        toast('Кликни по кнопке или тоглу чтобы добавить. Повторный клик прицела — выкл.');
        document.addEventListener('pointermove', onPickMove, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
    }

    function stopPick() {
        picking = false;
        document.body.classList.remove('qp-picking');
        if (panel) panel.classList.remove('qp-picking-active');
        if (hl) hl.classList.remove('qp-show');
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
        const uid = el.getAttribute('uid');
        const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);

        // Для uid-элементов (записи лорбука) — дедупликация только по uid
        if (uid && items.some(i => i.uid === uid)) { toast('Уже добавлено'); return; }
        // Для остальных — селектор + текст
        if (!uid && items.some(i => i.sel === sel && i.txt === txt)) { toast('Уже добавлено'); return; }

        const item = {
            id: 'i' + Date.now(), sel,
            name: nameFor(el), icon: iconFor(el),
            title: el.getAttribute('title') || '',
            txt
        };
        if (uid) item.uid = uid;

        // Запись лорбука — запоминаем, какой лорбук был открыт при добавлении
        if (el.closest('#WorldInfo, .world_entry, #world_popup')) {
            const ws = document.querySelector('#world_editor_select');
            if (ws) item.wi = ws.value;
        }
        items.push(item);
        saveItems();
        renderList();
        toast('Добавлено: ' + item.name);
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

        const box = lsGet(LS_BOX, null);
        if (box && !isMobile()) {
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
            if (el.classList.contains('qp-pinned')) return;
            try { localStorage.removeItem(LS_BOX); } catch (err) {}
            panel.style.width = '190px';
            panel.style.height = '230px';
            requestAnimationFrame(() => placePanel(true));
        });

        makeDraggable(panel, panel.querySelector('.qp-head'));
        makeResizable(panel, panel.querySelector('.qp-grip'));
        renderList();
    }

    function renderList() {
        if (!listEl) return;
        listEl.innerHTML = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'qp-empty';
            empty.textContent = 'Пусто. Зажми любой элемент в таверне чтобы добавить его сюда.';
            listEl.appendChild(empty);
            return;
        }
        items.forEach((it, idx) => {
            const target = resolveItem(it);
            const chip = document.createElement('div');
            chip.className = 'qp-chip' + (target ? '' : ' qp-missing');
            chip.title = target ? it.name : 'Элемент не найден на странице';

            const ic = document.createElement('i');
            ic.className = it.icon + ' qp-chip-ic';

            const label = document.createElement('span');
            label.className = 'qp-chip-lb';
            label.textContent = it.name;

            const dot = document.createElement('span');
            dot.className = 'qp-chip-dot';
            chip.appendChild(dot);
            chip.appendChild(ic);
            chip.appendChild(label);
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

            // Кнопка удаления всегда видна
            const del = document.createElement('i');
            del.className = 'fa-solid fa-trash qp-chip-del';
            del.title = 'Удалить';
            chip.appendChild(del);

            const tools = document.createElement('div');
            tools.className = 'qp-chip-tools';
            tools.innerHTML =
                '<i class="fa-solid fa-arrow-up qp-t qp-up" title="Выше"></i>' +
                '<i class="fa-solid fa-arrow-down qp-t qp-dn" title="Ниже"></i>';
            chip.appendChild(tools);

            // Долгое нажатие запускает селектор
            let longTimer = null;
            chip.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.qp-chip-del, .qp-chip-tools')) return;
                longTimer = setTimeout(() => {
                    longTimer = null;
                    if (!panel.classList.contains('qp-editing')) startPick();
                }, LONGPRESS_MS);
            });
            chip.addEventListener('pointerup', () => { clearTimeout(longTimer); });
            chip.addEventListener('pointercancel', () => { clearTimeout(longTimer); });
            chip.addEventListener('pointermove', () => { clearTimeout(longTimer); });

            chip.addEventListener('click', (e) => {
                // Удаление всегда работает
                if (e.target.closest('.qp-chip-del')) {
                    items.splice(idx, 1);
                    saveItems();
                    renderList();
                    return;
                }
                if (chip.classList.contains('qp-has-sel')) return;

                if (panel.classList.contains('qp-editing')) {
                    if (e.target.closest('.qp-up'))  { if (idx > 0) { items.splice(idx - 1, 0, items.splice(idx, 1)[0]); saveItems(); renderList(); } return; }
                    if (e.target.closest('.qp-dn'))  { if (idx < items.length - 1) { items.splice(idx + 1, 0, items.splice(idx, 1)[0]); saveItems(); renderList(); } return; }
                    startRename(chip, label, it);
                    return;
                }
                chip.classList.remove('qp-flash');
                void chip.offsetWidth;
                chip.classList.add('qp-flash');
                if (it.wi !== undefined) {
                    openLorebook(it, () => {
                        let t = resolveItem(it);
                        if (!t) {
                            // Лорбук грузится — пробуем ещё раз через 400мс
                            setTimeout(() => {
                                t = resolveItem(it);
                                if (!t) { toast('Запись не найдена в лорбуке'); renderList(); return; }
                                fire(t);
                                setTimeout(() => { syncStates(); renderList(); }, 120);
                            }, 400);
                            return;
                        }
                        fire(t);
                        setTimeout(() => { syncStates(); renderList(); }, 120);
                    });
                    return;
                }
                const t = resolveItem(it);
                if (!t) { toast('Элемент не найден'); renderList(); return; }
                fire(t);
                setTimeout(syncStates, 120);
            });

            listEl.appendChild(chip);
        });
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

    function safeQuery(sel) {
        try { return document.querySelector(sel); } catch (e) { return null; }
    }

    function syncStates() {
        if (!listEl) return;
        Array.from(listEl.children).forEach((chip, i) => {
            const it = items[i];
            if (!it) return;
            const t = resolveItem(it);
            chip.classList.toggle('qp-missing', !t);
            let on = false, isTgl = false;
            if (t && !isDrawerHead(t)) {
                if (t.matches('input[type=checkbox], input[type=radio]')) {
                    isTgl = true; on = t.checked;
                } else if (/fa-toggle-on/.test(t.className)) {
                    isTgl = true; on = true;
                } else if (/fa-toggle-off/.test(t.className)) {
                    isTgl = true; on = false;
                } else if (/(^|[-_\s])toggle([-_\s]|$)/i.test(t.className || '')) {
                    isTgl = true; on = !t.closest('[class*="disabled"]');
                } else {
                    const inn = t.querySelector('input[type=checkbox]');
                    if (inn) { isTgl = true; on = inn.checked; }
                }
            }
            chip.classList.toggle('qp-tgl', isTgl);
            chip.classList.toggle('qp-on', on);
                        const ms = chip.querySelector('.qp-chip-sel');
            if (ms && t && t.tagName === 'SELECT' && document.activeElement !== ms) {
                if (ms.options.length !== t.options.length) { renderList(); return; }
                ms.value = t.value;
            }
        });
    }

    function placePanel(ignoreSaved) {
        if (isMobile()) {
            const mbox = ignoreSaved ? null : lsGet(LS_BOX, null);
            const w = clamp(mbox?.width  || Math.min(220, Math.round(window.innerWidth * 0.62)), 150, window.innerWidth  - 8);
            const h = clamp(mbox?.height || 260, 140, window.innerHeight - 8);
            panel.style.width  = w + 'px';
            panel.style.height = h + 'px';
            if (mbox && typeof mbox.left === 'number') {
                panel.style.left = clamp(mbox.left, 4, window.innerWidth  - w - 4) + 'px';
                panel.style.top  = clamp(mbox.top,  4, window.innerHeight - h - 4) + 'px';
            } else {
                panel.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
                panel.style.top  = Math.round(window.innerHeight * 0.22) + 'px';
            }
            return;
        }
        const w = panel.offsetWidth || 190;
        const h = panel.offsetHeight || 230;
        const box = ignoreSaved ? null : lsGet(LS_BOX, null);
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
        lsSet(LS_BOX, { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight });
    }

    function openPanel() {
        if (!panel) buildPanel();
        panel.classList.add('qp-open');
        requestAnimationFrame(() => placePanel(false));
        renderList();
        clearInterval(tickTimer);
        tickTimer = setInterval(syncStates, 1200);
    }
    function closePanel() {
        if (panel) panel.classList.remove('qp-open');
        clearInterval(tickTimer);
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

        const mkCheck = (id, text, val) => {
            const l = document.createElement('label');
            l.className = 'checkbox_label';
            l.htmlFor = id;
            const c = document.createElement('input');
            c.type = 'checkbox'; c.id = id; c.checked = val;
            const s = document.createElement('span');
            s.textContent = text;
            l.appendChild(c); l.appendChild(s);
            return { label: l, input: c };
        };

        const cFloat = mkCheck('qp-cfg-float', 'Плавающая кнопка', cfg.float);
        const cWand  = mkCheck('qp-cfg-wand',  'Пункт в меню палочки', cfg.wand);

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

        cFloat.input.addEventListener('change', () => { cfg.float = cFloat.input.checked; saveCfg(); applyFloat(); });
        cWand.input.addEventListener('change',  () => { cfg.wand  = cWand.input.checked;  saveCfg(); mountWand(); });

        bOpen.addEventListener('click', () => togglePanel());
        bPick.addEventListener('click', () => startPick());
        bReset.addEventListener('click', () => {
            try { localStorage.removeItem(LS_BTNPOS); localStorage.removeItem(LS_BOX); } catch (e) {}
            const w = btn.offsetWidth || 42;
            btn.style.left = (window.innerWidth - w - 14) + 'px';
            btn.style.top  = Math.round(window.innerHeight * 0.5) + 'px';
            if (panel) { panel.style.width = '190px'; panel.style.height = '230px'; requestAnimationFrame(() => placePanel(true)); }
        });
        bClear.addEventListener('click', () => {
            items = []; saveItems(); renderList(); toast('Список очищен');
        });

        return true;
    }

    /* ---------------- СТАРТ ---------------- */

    applyFloat();

    window.addEventListener('resize', () => {
        const w = btn.offsetWidth, h = btn.offsetHeight;
        btn.style.left = clamp(btn.offsetLeft, 4, window.innerWidth - w - 4) + 'px';
        btn.style.top  = clamp(btn.offsetTop,  4, window.innerHeight - h - 4) + 'px';
        if (panel && panel.classList.contains('qp-open')) {
            panel.style.left = clamp(panel.offsetLeft, 8, Math.max(8, window.innerWidth  - panel.offsetWidth  - 8)) + 'px';
            panel.style.top  = clamp(panel.offsetTop,  8, Math.max(8, window.innerHeight - panel.offsetHeight - 8)) + 'px';
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
