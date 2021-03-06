const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Signals = imports.signals;
const St = imports.gi.St;

const Calendar = imports.ui.calendar;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;

const MESSAGE_ANIMATION_TIME = 0.1;

const DEFAULT_EXPAND_LINES = 6;

function _fixMarkup(text, allowMarkup) {
    if (allowMarkup) {
        // Support &amp;, &quot;, &apos;, &lt; and &gt;, escape all other
        // occurrences of '&'.
        let _text = text.replace(/&(?!amp;|quot;|apos;|lt;|gt;)/g, '&amp;');

        // Support <b>, <i>, and <u>, escape anything else
        // so it displays as raw markup.
        _text = _text.replace(/<(?!\/?[biu]>)/g, '&lt;');

        try {
            Pango.parse_markup(_text, -1, '');
            return _text;
        } catch (e) {}
    }

    // !allowMarkup, or invalid markup
    return GLib.markup_escape_text(text, -1);
}

const URLHighlighter = new Lang.Class({
    Name: 'URLHighlighter',

    _init: function(text, lineWrap, allowMarkup) {
        if (!text)
            text = '';
        this.actor = new St.Label({ reactive: true, style_class: 'url-highlighter',
                                    x_expand: true, x_align: Clutter.ActorAlign.START });
        this._linkColor = '#ccccff';
        this.actor.connect('style-changed', Lang.bind(this, function() {
            let [hasColor, color] = this.actor.get_theme_node().lookup_color('link-color', false);
            if (hasColor) {
                let linkColor = color.to_string().substr(0, 7);
                if (linkColor != this._linkColor) {
                    this._linkColor = linkColor;
                    this._highlightUrls();
                }
            }
        }));
        this.actor.clutter_text.line_wrap = lineWrap;
        this.actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

        this.setMarkup(text, allowMarkup);
        this.actor.connect('button-press-event', Lang.bind(this, function(actor, event) {
            // Don't try to URL highlight when invisible.
            // The MessageTray doesn't actually hide us, so
            // we need to check for paint opacities as well.
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            // Keep Notification.actor from seeing this and taking
            // a pointer grab, which would block our button-release-event
            // handler, if an URL is clicked
            return this._findUrlAtPos(event) != -1;
        }));
        this.actor.connect('button-release-event', Lang.bind(this, function (actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            let urlId = this._findUrlAtPos(event);
            if (urlId != -1) {
                let url = this._urls[urlId].url;
                if (url.indexOf(':') == -1)
                    url = 'http://' + url;

                Gio.app_info_launch_default_for_uri(url, global.create_app_launch_context(0, -1));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this.actor.connect('motion-event', Lang.bind(this, function(actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            let urlId = this._findUrlAtPos(event);
            if (urlId != -1 && !this._cursorChanged) {
                global.screen.set_cursor(Meta.Cursor.POINTING_HAND);
                this._cursorChanged = true;
            } else if (urlId == -1) {
                global.screen.set_cursor(Meta.Cursor.DEFAULT);
                this._cursorChanged = false;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this.actor.connect('leave-event', Lang.bind(this, function() {
            if (!this.actor.visible || this.actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            if (this._cursorChanged) {
                this._cursorChanged = false;
                global.screen.set_cursor(Meta.Cursor.DEFAULT);
            }
            return Clutter.EVENT_PROPAGATE;
        }));
    },

    setMarkup: function(text, allowMarkup) {
        text = text ? _fixMarkup(text, allowMarkup) : '';
        this._text = text;

        this.actor.clutter_text.set_markup(text);
        /* clutter_text.text contain text without markup */
        this._urls = Util.findUrls(this.actor.clutter_text.text);
        this._highlightUrls();
    },

    _highlightUrls: function() {
        // text here contain markup
        let urls = Util.findUrls(this._text);
        let markup = '';
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            let str = this._text.substr(pos, url.pos - pos);
            markup += str + '<span foreground="' + this._linkColor + '"><u>' + url.url + '</u></span>';
            pos = url.pos + url.url.length;
        }
        markup += this._text.substr(pos);
        this.actor.clutter_text.set_markup(markup);
    },

    _findUrlAtPos: function(event) {
        let success;
        let [x, y] = event.get_coords();
        [success, x, y] = this.actor.transform_stage_point(x, y);
        let find_pos = -1;
        for (let i = 0; i < this.actor.clutter_text.text.length; i++) {
            let [success, px, py, line_height] = this.actor.clutter_text.position_to_coords(i);
            if (py > y || py + line_height < y || x < px)
                continue;
            find_pos = i;
        }
        if (find_pos != -1) {
            for (let i = 0; i < this._urls.length; i++)
            if (find_pos >= this._urls[i].pos &&
                this._urls[i].pos + this._urls[i].url.length > find_pos)
                return i;
        }
        return -1;
    }
});

const ScaleLayout = new Lang.Class({
    Name: 'ScaleLayout',
    Extends: Clutter.BinLayout,

    _connectContainer: function(container) {
        if (this._container == container)
            return;

        if (this._container)
            for (let id of this._signals)
                this._container.disconnect(id);

        this._container = container;
        this._signals = [];

        if (this._container)
            for (let signal of ['notify::scale-x', 'notify::scale-y']) {
                let id = this._container.connect(signal, Lang.bind(this,
                    function() {
                        this.layout_changed();
                    }));
                this._signals.push(id);
            }
    },

    vfunc_get_preferred_width: function(container, forHeight) {
        this._connectContainer(container);

        let [min, nat] = this.parent(container, forHeight);
        return [Math.floor(min * container.scale_x),
                Math.floor(nat * container.scale_x)];
    },

    vfunc_get_preferred_height: function(container, forWidth) {
        this._connectContainer(container);

        let [min, nat] = this.parent(container, forWidth);
        return [Math.floor(min * container.scale_y),
                Math.floor(nat * container.scale_y)];
    }
});

const LabelExpanderLayout = new Lang.Class({
    Name: 'LabelExpanderLayout',
    Extends: Clutter.LayoutManager,
    Properties: { 'expansion': GObject.ParamSpec.double('expansion',
                                                        'Expansion',
                                                        'Expansion of the layout, between 0 (collapsed) ' +
                                                        'and 1 (fully expanded',
                                                         GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                                         0, 1, 0)},

    _init: function(params) {
        this._expansion = 0;
        this._expandLines = DEFAULT_EXPAND_LINES;

        this.parent(params);
    },

    get expansion() {
        return this._expansion;
    },

    set expansion(v) {
        if (v == this._expansion)
            return;
        this._expansion = v;
        this.notify('expansion');

        let visibleIndex = this._expansion > 0 ? 1 : 0;
        for (let i = 0; this._container && i < this._container.get_n_children(); i++)
            this._container.get_child_at_index(i).visible = (i == visibleIndex);

        this.layout_changed();
    },

    set expandLines(v) {
        if (v == this._expandLines)
            return;
        this._expandLines = v;
        if (this._expansion > 0)
            this.layout_changed();
    },

    vfunc_set_container: function(container) {
        this._container = container;
    },

    vfunc_get_preferred_width: function(container, forHeight) {
        let [min, nat] = [0, 0];

        for (let i = 0; i < container.get_n_children(); i++) {
            if (i > 1)
                break; // we support one unexpanded + one expanded child

            let child = container.get_child_at_index(i);
            let [childMin, childNat] = child.get_preferred_width(forHeight);
            [min, nat] = [Math.max(min, childMin), Math.max(nat, childNat)];
        }

        return [min, nat];
    },

    vfunc_get_preferred_height: function(container, forWidth) {
        let [min, nat] = [0, 0];

        let children = container.get_children();
        if (children[0])
            [min, nat] = children[0].get_preferred_height(forWidth);

        if (children[1]) {
            let [min2, nat2] = children[1].get_preferred_height(forWidth);
            let [expMin, expNat] = [Math.min(min2, min * this._expandLines),
                                    Math.min(nat2, nat * this._expandLines)];
            [min, nat] = [min + this._expansion * (expMin - min),
                          nat + this._expansion * (expNat - nat)];
        }

        return [min, nat];
    },

    vfunc_allocate: function(container, box, flags) {
        for (let i = 0; i < container.get_n_children(); i++) {
            let child = container.get_child_at_index(i);

            if (child.visible)
                child.allocate(box, flags);
        }

    }
});

const Message = new Lang.Class({
    Name: 'Message',

    _init: function(title, body) {
        this.expanded = false;

        this.actor = new St.Button({ style_class: 'message',
                                     accessible_role: Atk.Role.NOTIFICATION,
                                     can_focus: true,
                                     x_expand: true, x_fill: true });
        this.actor.connect('key-press-event',
                           Lang.bind(this, this._onKeyPressed));

        let vbox = new St.BoxLayout({ vertical: true });
        this.actor.set_child(vbox);

        let hbox = new St.BoxLayout();
        vbox.add_actor(hbox);

        this._actionBin = new St.Widget({ layout_manager: new ScaleLayout(),
                                          visible: false });
        vbox.add_actor(this._actionBin);

        this._iconBin = new St.Bin({ style_class: 'message-icon-bin',
                                     y_expand: true,
                                     visible: false });
        hbox.add_actor(this._iconBin);

        let contentBox = new St.BoxLayout({ style_class: 'message-content',
                                            vertical: true, x_expand: true });
        hbox.add_actor(contentBox);

        this._mediaControls = new St.BoxLayout();
        hbox.add_actor(this._mediaControls);

        let titleBox = new St.BoxLayout();
        contentBox.add_actor(titleBox);

        this.titleLabel = new St.Label({ style_class: 'message-title',
                                         x_expand: true,
                                         x_align: Clutter.ActorAlign.START });
        this.setTitle(title);
        titleBox.add_actor(this.titleLabel);

        this._secondaryBin = new St.Bin({ style_class: 'message-secondary-bin' });
        titleBox.add_actor(this._secondaryBin);

        let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic',
                                      icon_size: 16 });
        this._closeButton = new St.Button({ child: closeIcon, visible: false });
        titleBox.add_actor(this._closeButton);

        this._bodyStack = new St.Widget({ x_expand: true });
        this._bodyStack.layout_manager = new LabelExpanderLayout();
        contentBox.add_actor(this._bodyStack);

        this.bodyLabel = new URLHighlighter('', false, this._useBodyMarkup);
        this.bodyLabel.actor.add_style_class_name('message-body');
        this._bodyStack.add_actor(this.bodyLabel.actor);
        this.setBody(body);

        this._closeButton.connect('clicked', Lang.bind(this, this.close));
        this.actor.connect('notify::hover', Lang.bind(this, this._sync));
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
        this._sync();
    },

    close: function() {
        this.emit('close');
    },

    setIcon: function(actor) {
        this._iconBin.child = actor;
        this._iconBin.visible = (actor != null);
    },

    setSecondaryActor: function(actor) {
        this._secondaryBin.child = actor;
    },

    setTitle: function(text) {
        let title = text ? _fixMarkup(text.replace(/\n/g, ' '), false) : '';
        this.titleLabel.clutter_text.set_markup(title);
    },

    setBody: function(text) {
        this._bodyText = text;
        this.bodyLabel.setMarkup(text ? text.replace(/\n/g, ' ') : '',
                                 this._useBodyMarkup);
        if (this._expandedLabel)
            this._expandedLabel.setMarkup(text, this._useBodyMarkup);
    },

    setUseBodyMarkup: function(enable) {
        if (this._useBodyMarkup === enable)
            return;
        this._useBodyMarkup = enable;
        if (this.bodyLabel)
            this.setBody(this._bodyText);
    },

    setActionArea: function(actor) {
        if (actor == null) {
            if (this._actionBin.get_n_children() > 0)
                this._actionBin.get_child_at_index(0).destroy();
            return;
        }

        if (this._actionBin.get_n_children() > 0)
            throw new Error('Message already has an action area');

        this._actionBin.add_actor(actor);
        this._actionBin.visible = this.expanded;
    },

    addMediaControl: function(iconName, callback) {
        let icon = new St.Icon({ icon_name: iconName, icon_size: 16 });
        let button = new St.Button({ style_class: 'message-media-control',
                                     child: icon });
        button.connect('clicked', callback);
        this._mediaControls.add_actor(button);
        return button;
    },

    setExpandedBody: function(actor) {
        if (actor == null) {
            if (this._bodyStack.get_n_children() > 1)
                this._bodyStack.get_child_at_index(1).destroy();
            return;
        }

        if (this._bodyStack.get_n_children() > 1)
            throw new Error('Message already has an expanded body actor');

        this._bodyStack.insert_child_at_index(actor, 1);
    },

    setExpandedLines: function(nLines) {
        this._bodyStack.layout_manager.expandLines = nLines;
    },

    expand: function(animate) {
        this.expanded = true;

        this._actionBin.visible = (this._actionBin.get_n_children() > 0);

        if (this._bodyStack.get_n_children() < 2) {
            this._expandedLabel = new URLHighlighter(this._bodyText,
                                                     true, this._useBodyMarkup);
            this.setExpandedBody(this._expandedLabel.actor);
        }

        if (animate) {
            Tweener.addTween(this._bodyStack.layout_manager,
                             { expansion: 1,
                               time: MessageTray.ANIMATION_TIME,
                               transition: 'easeOutQuad' });
            this._actionBin.scale_y = 0;
            Tweener.addTween(this._actionBin,
                             { scale_y: 1,
                               time: MessageTray.ANIMATION_TIME,
                               transition: 'easeOutQuad' });
        } else {
            this._bodyStack.layout_manager.expansion = 1;
            this._actionBin.scale_y = 1;
        }

        this.emit('expanded');
    },

    unexpand: function(animate) {
        if (animate) {
            Tweener.addTween(this._bodyStack.layout_manager,
                             { expansion: 0,
                               time: MessageTray.ANIMATION_TIME,
                               transition: 'easeOutQuad' });
            Tweener.addTween(this._actionBin,
                             { scale_y: 0,
                               time: MessageTray.ANIMATION_TIME,
                               transition: 'easeOutQuad',
                               onCompleteScope: this,
                               onComplete: function() {
                                   this._actionBin.hide();
                                   this.expanded = false;
                               }});
        } else {
            this._bodyStack.layout_manager.expansion = 0;
            this._actionBin.scale_y = 0;
            this.expanded = false;
        }

        this.emit('unexpanded');
    },

    canClose: function() {
        return this._mediaControls.get_n_children() == 0;
    },

    _sync: function() {
        let hovered = this.actor.hover;
        this._closeButton.visible = hovered && this.canClose();
        this._secondaryBin.visible = !hovered;
    },

    _onClicked: function() {
    },

    _onDestroy: function() {
    },

    _onKeyPressed: function(a, event) {
        let keysym = event.get_key_symbol();

        if (keysym == Clutter.KEY_Delete ||
            keysym == Clutter.KEY_KP_Delete) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
Signals.addSignalMethods(Message.prototype);

const MessageListSection = new Lang.Class({
    Name: 'MessageListSection',

    _init: function(title) {
        this.actor = new St.BoxLayout({ style_class: 'message-list-section',
                                        clip_to_allocation: true,
                                        x_expand: true, vertical: true });
        let titleBox = new St.BoxLayout({ style_class: 'message-list-section-title-box' });
        this.actor.add_actor(titleBox);

        this._title = new St.Button({ style_class: 'message-list-section-title',
                                      label: title,
                                      can_focus: true,
                                      x_expand: true,
                                      x_align: St.Align.START });
        titleBox.add_actor(this._title);

        this._title.connect('clicked', Lang.bind(this, this._onTitleClicked));
        this._title.connect('key-focus-in', Lang.bind(this, this._onKeyFocusIn));

        let closeIcon = new St.Icon({ icon_name: 'window-close-symbolic' });
        this._closeButton = new St.Button({ style_class: 'message-list-section-close',
                                            child: closeIcon,
                                            accessible_name: _("Clear section"),
                                            can_focus: true });
        this._closeButton.set_x_align(Clutter.ActorAlign.END);
        titleBox.add_actor(this._closeButton);

        this._closeButton.connect('clicked', Lang.bind(this, this.clear));

        this._list = new St.BoxLayout({ style_class: 'message-list-section-list',
                                        vertical: true });
        this.actor.add_actor(this._list);

        this._list.connect('actor-added', Lang.bind(this, this._sync));
        this._list.connect('actor-removed', Lang.bind(this, this._sync));

        let id = Main.sessionMode.connect('updated',
                                          Lang.bind(this, this._sync));
        this.actor.connect('destroy', function() {
            Main.sessionMode.disconnect(id);
        });

        this._messages = new Map();
        this._date = new Date();
        this.empty = true;
        this._sync();
    },

    _onTitleClicked: function() {
        Main.overview.hide();
        Main.panel.closeCalendar();
    },

    _onKeyFocusIn: function(actor) {
        this.emit('key-focus-in', actor);
    },

    get allowed() {
        return true;
    },

    setDate: function(date) {
        if (Calendar.sameDay(date, this._date))
            return;
        this._date = date;
        this._sync();
    },

    addMessage: function(message, animate) {
        this.addMessageAtIndex(message, -1, animate);
    },

    addMessageAtIndex: function(message, index, animate) {
        let obj = {
            container: null,
            destroyId: 0,
            keyFocusId: 0,
            closeId: 0
        };
        let pivot = new Clutter.Point({ x: .5, y: .5 });
        let scale = animate ? 0 : 1;
        obj.container = new St.Widget({ layout_manager: new ScaleLayout(),
                                        pivot_point: pivot,
                                        scale_x: scale, scale_y: scale });
        obj.keyFocusId = message.actor.connect('key-focus-in',
            Lang.bind(this, this._onKeyFocusIn));
        obj.destroyId = message.actor.connect('destroy',
            Lang.bind(this, function() {
                this.removeMessage(message, false);
            }));
        obj.closeId = message.connect('close',
            Lang.bind(this, function() {
                this.removeMessage(message, true);
            }));

        this._messages.set(message, obj);
        obj.container.add_actor(message.actor);

        this._list.insert_child_at_index(obj.container, index);

        if (animate)
            Tweener.addTween(obj.container, { scale_x: 1,
                                              scale_y: 1,
                                              time: MESSAGE_ANIMATION_TIME,
                                              transition: 'easeOutQuad' });
    },

    moveMessage: function(message, index, animate) {
        let obj = this._messages.get(message);

        if (!animate) {
            this._list.set_child_at_index(obj.container, index);
            return;
        }

        let onComplete = Lang.bind(this, function() {
            this._list.set_child_at_index(obj.container, index);
            Tweener.addTween(obj.container, { scale_x: 1,
                                              scale_y: 1,
                                              time: MESSAGE_ANIMATION_TIME,
                                              transition: 'easeOutQuad' });
        });
        Tweener.addTween(obj.container, { scale_x: 0,
                                          scale_y: 0,
                                          time: MESSAGE_ANIMATION_TIME,
                                          transition: 'easeOutQuad',
                                          onComplete: onComplete });
    },

    removeMessage: function(message, animate) {
        let obj = this._messages.get(message);

        message.actor.disconnect(obj.destroyId);
        message.actor.disconnect(obj.keyFocusId);
        message.disconnect(obj.closeId);

        this._messages.delete(message);

        if (animate) {
            Tweener.addTween(obj.container, { scale_x: 0, scale_y: 0,
                                              time: MESSAGE_ANIMATION_TIME,
                                              transition: 'easeOutQuad',
                                              onComplete: function() {
                                                  obj.container.destroy();
                                                  global.sync_pointer();
                                              }});
        } else {
            obj.container.destroy();
            global.sync_pointer();
        }
    },

    clear: function() {
        let messages = [...this._messages.keys()].filter(function(message) {
            return message.canClose();
        });

        // If there are few messages, letting them all zoom out looks OK
        if (messages.length < 2) {
            messages.forEach(function(message) {
                message.close();
            });
        } else {
            // Otherwise we slide them out one by one, and then zoom them
            // out "off-screen" in the end to smoothly shrink the parent
            let delay = MESSAGE_ANIMATION_TIME / Math.max(messages.length, 5);
            for (let i = 0; i < messages.length; i++) {
                let message = messages[i];
                let obj = this._messages.get(message);
                Tweener.addTween(obj.container,
                                 { anchor_x: this._list.width,
                                   opacity: 0,
                                   time: MESSAGE_ANIMATION_TIME,
                                   delay: i * delay,
                                   transition: 'easeOutQuad',
                                   onComplete: function() {
                                       message.close();
                                   }});
            }
        }
    },

    _canClear: function() {
        for (let message of this._messages.keys())
            if (message.canClose())
                return true;
        return false;
    },

    _shouldShow: function() {
        return !this.empty;
    },

    _sync: function() {
        let empty = this._list.get_n_children() == 0;
        let changed = this.empty !== empty;
        this.empty = empty;

        if (changed)
            this.emit('empty-changed');

        this._closeButton.visible = this._canClear();
        this.actor.visible = this.allowed && this._shouldShow();
    }
});
Signals.addSignalMethods(MessageListSection.prototype);
