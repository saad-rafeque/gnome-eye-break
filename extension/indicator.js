// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Saad Rafique
// The top bar icon and its menu.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, ext.metadata.name);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({gicon: ext.icons.active, style_class: 'system-status-icon'});
        this._label = new St.Label({
            style_class: 'eyebreak-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        this._icons = ext.icons;

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._status.label.add_style_class_name('eyebreak-menu-status');
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pauseItem = new PopupMenu.PopupSwitchMenuItem('Pause reminders', false);
        this._pauseItem.connect('toggled', (_item, state) => ext.setPaused(state));
        this.menu.addMenuItem(this._pauseItem);

        this._breakNowItem = this.menu.addAction('Take a break now', () => ext.takeBreakNow());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Break style'));
        this._modeItems = {
            banner: this.menu.addAction('Banner', () => ext.setMode('banner')),
            fullscreen: this.menu.addAction('Fullscreen', () => ext.setMode('fullscreen')),
        };

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => ext.openPreferences());

        // The status line counts down, so bring it up to date as the menu opens.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                ext.refresh();
        });
    }

    // Called every second, so only touch what actually changed.
    update(state) {
        const last = this._last ?? {};
        this._last = state;

        if (state.paused !== last.paused) {
            this._icon.gicon = state.paused ? this._icons.paused : this._icons.active;
            this._pauseItem.setToggleState(state.paused);
        }
        if (state.panelText !== last.panelText) {
            this._label.text = state.panelText;
            this._label.visible = state.panelText !== '';
        }
        // The status line is only visible with the menu open.
        if (this.menu.isOpen && state.statusText !== this._status.label.text)
            this._status.label.text = state.statusText;
        if (state.canBreakNow !== last.canBreakNow)
            this._breakNowItem.setSensitive(state.canBreakNow);
        if (state.mode !== last.mode) {
            for (const [key, item] of Object.entries(this._modeItems))
                item.setOrnament(key === state.mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
    }
});
