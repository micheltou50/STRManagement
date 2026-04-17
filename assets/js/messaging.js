/**
 * StayOps — In-App Messaging Module
 * Handles all chat logic, UI rendering, Realtime subscriptions, and push notifications.
 */

import { getCurrentSupabaseUser } from './supabase.js';
import { getCleanerSub, sendPushToDevice } from './notifications.js';
import { cleans } from './state.js';
import { escHtml } from './utils.js';
import { getCurrentPropertyName } from './config.js';

// ── STATE ────────────────────────────────────────────────────────────────────
let _channel = null;        // Supabase Realtime channel
let _conversations = [];    // Cached conversation list
let _activeThread = null;   // Currently open cleaner_id
let _unreadTotal = 0;       // Total unread count
let _chatOpen = false;      // Is chat panel visible
let _chatView = 'list';     // 'list' | 'thread'
let _previewTimer = null;   // Auto-dismiss timer for preview popup

// ── CARD CONFIG ──────────────────────────────────────────────────────────────
const CARD_GRADIENTS = {
  clean_assigned:    'linear-gradient(90deg,#1E3A2F,#8FAF85)',
  clean_confirmed:   'linear-gradient(90deg,#34C759,#8BC34A)',
  clean_declined:    'linear-gradient(90deg,#FF3B30,#FF6B6B)',
  clean_complete:    'linear-gradient(90deg,#34C759,#8BC34A)',
  maintenance_flag:  'linear-gradient(90deg,#FF9500,#FFB74D)',
};

const CARD_ICONS = {
  clean_assigned:    '\u{1F3E0}',
  clean_confirmed:   '\u2705',
  clean_declined:    '\u274C',
  clean_complete:    '\u2705',
  maintenance_flag:  '\u{1F527}',
};

const CARD_TITLES = {
  clean_assigned:    'Clean Assigned',
  clean_confirmed:   'Clean Confirmed',
  clean_declined:    'Clean Declined',
  clean_complete:    'Clean Complete',
  maintenance_flag:  'Maintenance Flagged',
};

const CARD_TITLE_COLORS = {
  clean_assigned:    '#1E3A2F',
  clean_confirmed:   '#2E7D32',
  clean_declined:    '#C62828',
  clean_complete:    '#2E7D32',
  maintenance_flag:  '#1E3A2F',
};

// Deterministic avatar colours
const AVATAR_COLORS = [
  '#8FAF85', '#6B9BD2', '#D4A574', '#C4A0D4', '#E8967D',
  '#7BCDC8', '#B0886F', '#9B8EC2', '#E6A97E', '#82B7A0',
];

// ── HELPERS ──────────────────────────────────────────────────────────────────

function _sb() {
  return window._sb || null;
}

function _cleaners() {
  return window._cleaners || [];
}

function _getCleanerName(cleanerId) {
  const c = _cleaners().find(
    (cl) => String(cl.id) === String(cleanerId) || String(cl.cleanerId) === String(cleanerId)
  );
  return c ? (c.name || c.cleanerName || 'Cleaner') : 'Cleaner';
}

function _getInitials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function _avatarColor(cleanerId) {
  const idx = Math.abs(String(cleanerId).split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

function _formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function _formatConvTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function _formatDatePill(dateStr) {
  if (!dateStr) return 'TODAY';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 'TODAY';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return 'TODAY';
  if (isYesterday) return 'YESTERDAY';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
}

// ── 1. INIT MESSAGING ───────────────────────────────────────────────────────

export async function initMessaging() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return;
    const sb = _sb();
    if (!sb) return;

    // Subscribe to Realtime on messages table filtered by user_id
    if (_channel) {
      sb.removeChannel(_channel);
      _channel = null;
    }
    _channel = sb
      .channel('messages-realtime-' + user.id)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'user_id=eq.' + user.id,
        },
        (payload) => {
          if (payload && payload.new) _onNewMessage(payload.new);
        }
      )
      .subscribe((status) => {
        console.log('[StayOps Messaging] Realtime subscription status:', status);
      });

    // Load initial unread count
    await _updateUnreadBadge();

    // Render floating bubble
    renderChatBubble();

    console.log('[StayOps Messaging] Initialized');
  } catch (err) {
    console.error('[StayOps Messaging] initMessaging error:', err);
  }
}

// ── 2. ON NEW MESSAGE ────────────────────────────────────────────────────────

function _onNewMessage(msg) {
  try {
    // If this is the host's own message (optimistic already rendered), skip
    if (msg.sender_type === 'host') return;

    if (_chatOpen && _chatView === 'thread' && _activeThread && String(msg.cleaner_id) === String(_activeThread)) {
      // Append to current thread and mark as read
      _appendMessageToDOM(msg);
      markThreadRead(msg.cleaner_id);
    } else {
      // Increment unread, show preview
      _unreadTotal++;
      _renderBadgeCount();
      _showPreview(msg);
    }
  } catch (err) {
    console.error('[StayOps Messaging] _onNewMessage error:', err);
  }
}

// ── 3. LOAD CONVERSATIONS ───────────────────────────────────────────────────

export async function loadConversations() {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb) return [];

    // Fetch recent messages for this user, ordered newest first
    const { data: msgs, error } = await sb
      .from('messages')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.error('[StayOps Messaging] loadConversations error:', error.message);
      return [];
    }

    // Group by cleaner_id client-side
    const grouped = {};
    for (const m of (msgs || [])) {
      const cid = m.cleaner_id;
      if (!cid) continue;
      if (!grouped[cid]) {
        grouped[cid] = { lastMessage: m, unread: 0 };
      }
      // Count unread (messages from cleaner/system that host hasn't read)
      if (m.sender_type !== 'host' && !m.read_at) {
        grouped[cid].unread++;
      }
    }

    // Build conversation list
    const convs = Object.keys(grouped).map((cid) => {
      const { lastMessage, unread } = grouped[cid];
      const name = _getCleanerName(cid);
      return {
        cleanerId: cid,
        name,
        initials: _getInitials(name),
        color: _avatarColor(cid),
        lastMessage,
        lastMessageBody: lastMessage.body || '',
        lastMessageType: lastMessage.message_type || 'text',
        lastMessageTime: lastMessage.created_at,
        unread,
        isActive: _isCleanerActive(cid),
      };
    });

    // Sort by last message time descending
    convs.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    _conversations = convs;
    return convs;
  } catch (err) {
    console.error('[StayOps Messaging] loadConversations error:', err);
    return [];
  }
}

function _isCleanerActive(cleanerId) {
  // Check if this cleaner has any active (not done) cleans
  return cleans.some(
    (c) =>
      (String(c.cleanerId) === String(cleanerId) || String(c.cleaner) === String(cleanerId)) &&
      !c.done
  );
}

// ── 4. LOAD THREAD ──────────────────────────────────────────────────────────

export async function loadThread(cleanerId) {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb) return [];

    const { data: msgs, error } = await sb
      .from('messages')
      .select('*')
      .eq('user_id', user.id)
      .eq('cleaner_id', cleanerId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      console.error('[StayOps Messaging] loadThread error:', error.message);
      return [];
    }

    // Mark unread messages as read
    const unreadIds = (msgs || [])
      .filter((m) => m.sender_type !== 'host' && !m.read_at)
      .map((m) => m.id);

    if (unreadIds.length > 0) {
      sb.from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('cleaner_id', cleanerId)
        .neq('sender_type', 'host')
        .is('read_at', null)
        .then(() => _updateUnreadBadge())
        .catch((e) => console.warn('[StayOps Messaging] mark read error:', e));
    }

    return msgs || [];
  } catch (err) {
    console.error('[StayOps Messaging] loadThread error:', err);
    return [];
  }
}

// ── 5. SEND MESSAGE ─────────────────────────────────────────────────────────

export async function sendMessage(cleanerId, body, attachmentUrl) {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb) return null;

    const row = {
      user_id: user.id,
      cleaner_id: cleanerId,
      sender_type: 'host',
      message_type: attachmentUrl ? 'photo' : 'text',
      body: body || '',
      attachment_url: attachmentUrl || null,
    };

    // Optimistic: append to DOM immediately
    const optimistic = {
      ...row,
      id: 'opt-' + Date.now(),
      created_at: new Date().toISOString(),
      read_at: null,
    };
    if (_chatOpen && _chatView === 'thread' && String(_activeThread) === String(cleanerId)) {
      _appendMessageToDOM(optimistic);
    }

    const { data, error } = await sb.from('messages').insert(row).select().single();
    if (error) {
      console.error('[StayOps Messaging] sendMessage error:', error.message);
      return null;
    }

    // Send push to cleaner
    try {
      const sub = getCleanerSub(cleanerId);
      if (sub) {
        const preview = (body || '').slice(0, 60);
        await sendPushToDevice(sub, 'New message', preview);
      }
    } catch (pushErr) {
      console.warn('[StayOps Messaging] Push notification failed:', pushErr);
    }

    return data;
  } catch (err) {
    console.error('[StayOps Messaging] sendMessage error:', err);
    return null;
  }
}

// ── 6. SEND AUTO MESSAGE ────────────────────────────────────────────────────

export async function sendAutoMessage(cleanerId, cardType, cardData) {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb) return null;

    const row = {
      user_id: user.id,
      cleaner_id: cleanerId,
      sender_type: 'system',
      message_type: 'card',
      card_type: cardType || 'clean_assigned',
      card_data: cardData || {},
      body: CARD_TITLES[cardType] || cardType || '',
    };

    const { data, error } = await sb.from('messages').insert(row).select().single();
    if (error) {
      console.error('[StayOps Messaging] sendAutoMessage error:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error('[StayOps Messaging] sendAutoMessage error:', err);
    return null;
  }
}

// ── 7. MARK THREAD READ ─────────────────────────────────────────────────────

export async function markThreadRead(cleanerId) {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb) return;

    await sb
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('cleaner_id', cleanerId)
      .neq('sender_type', 'host')
      .is('read_at', null);

    await _updateUnreadBadge();
  } catch (err) {
    console.error('[StayOps Messaging] markThreadRead error:', err);
  }
}

// ── 8. GET UNREAD COUNT ─────────────────────────────────────────────────────

export function getUnreadCount() {
  return _unreadTotal;
}

// ── 9. UPLOAD CHAT PHOTO ────────────────────────────────────────────────────

export async function uploadChatPhoto(file) {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb || !file) return null;

    const path = user.id + '/messages/' + Date.now() + '.jpg';

    const { data: _data, error } = await sb.storage
      .from('receipts')
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });

    if (error) {
      console.error('[StayOps Messaging] uploadChatPhoto error:', error.message);
      return null;
    }

    const { data: urlData } = sb.storage.from('receipts').getPublicUrl(path);
    return urlData ? urlData.publicUrl : null;
  } catch (err) {
    console.error('[StayOps Messaging] uploadChatPhoto error:', err);
    return null;
  }
}

// ── 10. RENDER CHAT BUBBLE ──────────────────────────────────────────────────

export function renderChatBubble() {
  // Ensure container exists, or create one at body level
  let container = document.getElementById('stayops-chat-bubble');
  if (!container) {
    container = document.createElement('div');
    container.id = 'stayops-chat-bubble';
    document.body.appendChild(container);
  }

  container.innerHTML = `
    <div id="chat-fab" onclick="window._stayOpsOpenChat()" class="fab fab-chat" style="bottom:160px;transition:bottom 0.25s ease">
      <svg width="24" height="24" fill="none" stroke="#fff" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div id="chat-badge" style="display:none;position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;border-radius:10px;background:#FF3B30;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;border:2px solid #f5f5f3"></div>
    </div>
    <div id="chat-preview" style="display:none;position:fixed;bottom:220px;right:24px;z-index:98;background:#fff;padding:10px 14px;border-radius:14px 14px 4px 14px;box-shadow:0 4px 16px rgba(0,0,0,0.12);max-width:220px;cursor:pointer" onclick="window._stayOpsOpenChat()">
      <div id="chat-preview-name" style="font-weight:700;font-size:12px;color:#1E3A2F"></div>
      <div id="chat-preview-msg" style="font-size:12px;color:#666;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden"></div>
    </div>
  `;

  // Ensure chat panel container exists
  if (!document.getElementById('stayops-chat-panel')) {
    const panel = document.createElement('div');
    panel.id = 'stayops-chat-panel';
    panel.style.cssText = 'display:none;position:fixed;bottom:0;left:0;right:0;top:0;z-index:1000;flex-direction:column;background:#fff;transition:transform 0.3s ease;';
    document.body.appendChild(panel);
  }

  _renderBadgeCount();
}

// ── 11. RENDER CONVERSATION LIST ────────────────────────────────────────────

export async function renderConversationList() {
  const panel = document.getElementById('stayops-chat-panel');
  if (!panel) return;

  // Show loading state
  panel.innerHTML = `
    <div style="background:#1E3A2F;padding:48px 18px 14px;flex-shrink:0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-family:'DM Serif Display',serif;font-size:22px;color:#fff">Messages</span>
        <span onclick="window._stayOpsCloseChat()" style="color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:4px 8px">&times;</span>
      </div>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;background:#fff">
      <span style="color:#999;font-size:13px">Loading...</span>
    </div>
  `;
  panel.style.display = 'flex';

  const convs = await loadConversations();

  // Separate active vs team
  const active = convs.filter((c) => c.isActive);
  const team = convs.filter((c) => !c.isActive);

  let listHTML = '';

  if (active.length > 0) {
    listHTML += `<div style="padding:12px 18px 4px;font-size:10px;font-weight:700;color:#8FAF85;text-transform:uppercase;letter-spacing:1px">Active Cleans</div>`;
    listHTML += active.map(_renderConvRow).join('');
  }

  if (team.length > 0) {
    listHTML += `<div style="padding:12px 18px 4px;font-size:10px;font-weight:700;color:#8FAF85;text-transform:uppercase;letter-spacing:1px">Team</div>`;
    listHTML += team.map(_renderConvRow).join('');
  }

  if (convs.length === 0) {
    listHTML = `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;text-align:center">
        <div style="font-size:48px;margin-bottom:12px;opacity:0.4">💬</div>
        <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:4px">No messages yet</div>
        <div style="font-size:13px;color:#999;line-height:1.5">Messages with your cleaners will appear here when cleans are assigned.</div>
      </div>
    `;
  }

  panel.innerHTML = `
    <div style="background:#1E3A2F;padding:48px 18px 14px;flex-shrink:0">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-family:'DM Serif Display',serif;font-size:22px;color:#fff">Messages</span>
        <span onclick="window._stayOpsCloseChat()" style="color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:4px 8px">&times;</span>
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;background:#fff">
      ${listHTML}
    </div>
  `;
}

function _renderConvRow(conv) {
  const isUnread = conv.unread > 0;
  const bg = isUnread ? 'background:#FAFFF5;' : '';
  const nameWeight = isUnread ? 'font-weight:700;' : 'font-weight:600;';
  const previewColor = isUnread ? 'color:#555;' : 'color:#999;';
  const timeColor = isUnread ? 'color:#1E3A2F;font-weight:600;' : 'color:#999;';

  let preview = escHtml(conv.lastMessageBody);
  if (conv.lastMessageType === 'photo') preview = '\u{1F4F7} Photo';
  if (conv.lastMessageType === 'card') preview = '\u{1F4CB} ' + escHtml(conv.lastMessageBody);

  const badge = isUnread
    ? `<div style="width:22px;height:22px;border-radius:50%;background:#1E3A2F;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:4px;margin-left:auto">${conv.unread}</div>`
    : '';

  return `
    <div onclick="window._stayOpsOpenThread('${escHtml(conv.cleanerId)}')" style="${bg}display:flex;align-items:center;gap:14px;padding:14px 18px;cursor:pointer;border-bottom:1px solid #f5f4f0">
      <div style="width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;flex-shrink:0;background:${conv.color}">${escHtml(conv.initials)}</div>
      <div style="flex:1;min-width:0">
        <div style="${nameWeight}font-size:15px;color:#111">${escHtml(conv.name)}</div>
        <div style="${previewColor}font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">${preview}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="${timeColor}font-size:11px">${escHtml(_formatConvTime(conv.lastMessageTime))}</div>
        ${badge}
      </div>
    </div>
  `;
}

// ── 12. RENDER CHAT THREAD ──────────────────────────────────────────────────

export async function renderChatThread(cleanerId) {
  const panel = document.getElementById('stayops-chat-panel');
  if (!panel) return;

  const name = _getCleanerName(cleanerId);
  const initials = _getInitials(name);
  const color = _avatarColor(cleanerId);

  // Show loading
  panel.innerHTML = `
    <div style="background:#1E3A2F;padding:48px 14px 12px;display:flex;align-items:center;gap:10px;flex-shrink:0">
      <div onclick="window._stayOpsBackToList()" style="color:rgba(255,255,255,0.7);font-size:22px;cursor:pointer;padding:0 6px">&lsaquo;</div>
      <div style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;flex-shrink:0;border:2px solid rgba(255,255,255,0.2);background:${color}">${escHtml(initials)}</div>
      <div style="flex:1"><div style="color:#fff;font-weight:600;font-size:16px">${escHtml(name)}</div><div style="color:rgba(255,255,255,0.55);font-size:11px">online</div></div>
      <span onclick="window._stayOpsCloseChat()" style="color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:4px 8px">&times;</span>
    </div>
    <div style="flex:1;display:flex;align-items:center;justify-content:center;background:#E5DDD5">
      <span style="color:#8B8478;font-size:13px">Loading...</span>
    </div>
  `;
  panel.style.display = 'flex';

  const msgs = await loadThread(cleanerId);

  // Build messages HTML
  let msgsHTML = '';
  let lastDate = '';

  for (const msg of msgs) {
    // Date pill
    const msgDate = msg.created_at ? new Date(msg.created_at).toDateString() : '';
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      msgsHTML += `<div style="text-align:center;margin:8px 0 4px"><span style="background:rgba(255,255,255,0.85);padding:4px 12px;border-radius:8px;font-size:11px;color:#8B8478;font-weight:500;display:inline-block;box-shadow:0 1px 1px rgba(0,0,0,0.03)">${escHtml(_formatDatePill(msg.created_at))}</span></div>`;
    }

    msgsHTML += _renderMessageBubble(msg);
  }

  panel.innerHTML = `
    <div style="background:#1E3A2F;padding:48px 14px 12px;display:flex;align-items:center;gap:10px;flex-shrink:0">
      <div onclick="window._stayOpsBackToList()" style="color:rgba(255,255,255,0.7);font-size:22px;cursor:pointer;padding:0 6px">&lsaquo;</div>
      <div style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;flex-shrink:0;border:2px solid rgba(255,255,255,0.2);background:${color}">${escHtml(initials)}</div>
      <div style="flex:1"><div style="color:#fff;font-weight:600;font-size:16px">${escHtml(name)}</div><div style="color:rgba(255,255,255,0.55);font-size:11px">online</div></div>
      <span onclick="window._stayOpsCloseChat()" style="color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;padding:4px 8px">&times;</span>
    </div>
    <div id="chat-messages-area" style="flex:1;overflow-y:auto;padding:10px 10px 14px;display:flex;flex-direction:column;gap:3px;background-color:#E5DDD5;background-image:url(&quot;data:image/svg+xml,%3Csvg width='80' height='80' viewBox='0 0 80 80' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ccc5ba' fill-opacity='0.12'%3E%3Ccircle cx='20' cy='20' r='1.5'/%3E%3Ccircle cx='60' cy='60' r='1.5'/%3E%3Ccircle cx='60' cy='20' r='1'/%3E%3Ccircle cx='20' cy='60' r='1'/%3E%3C/g%3E%3C/svg%3E&quot;)">
      ${msgsHTML}
    </div>
    <div style="display:flex;align-items:flex-end;gap:6px;padding:6px 8px 24px;background:#E5DDD5;flex-shrink:0">
      <div style="flex:1;display:flex;align-items:center;background:#fff;border-radius:24px;padding:6px 10px;gap:6px">
        <label for="chat-photo-input" style="font-size:18px;opacity:0.35;cursor:pointer;flex-shrink:0">\u{1F4F7}</label>
        <input type="file" id="chat-photo-input" accept="image/*" style="display:none" onchange="window._stayOpsChatPhotoSelected(this)">
        <input type="text" id="chat-input-field" placeholder="Type a message..." style="flex:1;border:none;outline:none;font-size:14px;font-family:inherit;padding:4px 2px;color:#111;background:transparent" onkeydown="if(event.key==='Enter'){event.preventDefault();window._stayOpsSendFromInput();}">
      </div>
      <div onclick="window._stayOpsSendFromInput()" style="width:42px;height:42px;border-radius:50%;background:#1E3A2F;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </div>
    </div>
  `;

  // Scroll to bottom
  const area = document.getElementById('chat-messages-area');
  if (area) area.scrollTop = area.scrollHeight;
}

function _renderMessageBubble(msg) {
  // System card
  if (msg.message_type === 'card' || msg.sender_type === 'system') {
    return _renderSystemCard(msg);
  }

  // Photo message
  if (msg.message_type === 'photo' && msg.attachment_url) {
    return _renderPhotoBubble(msg);
  }

  // Text bubble
  const isHost = msg.sender_type === 'host';
  const align = isHost ? 'flex-end' : 'flex-start';
  const bg = isHost ? '#DCF8C6' : '#fff';
  const borderRadius = isHost ? '8px 8px 0 8px' : '8px 8px 8px 0';
  const shadow = isHost ? '' : 'box-shadow:0 1px 1px rgba(0,0,0,0.04);';
  const timeColor = isHost ? '#7D8B78' : '#999';
  const ticks = isHost ? `<span style="font-size:13px;color:#53BDEB">\u2713\u2713</span>` : '';

  return `
    <div style="align-self:${align};max-width:80%;padding:6px 10px 3px;font-size:14.5px;line-height:1.45;word-wrap:break-word;background:${bg};border-radius:${borderRadius};${shadow}">
      ${escHtml(msg.body || '')}
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:3px;margin-top:1px">
        <span style="font-size:10.5px;color:${timeColor}">${escHtml(_formatTime(msg.created_at))}</span>
        ${ticks}
      </div>
    </div>
  `;
}

function _renderSystemCard(msg) {
  const cardType = msg.card_type || 'clean_assigned';
  const gradient = CARD_GRADIENTS[cardType] || CARD_GRADIENTS.clean_assigned;
  const icon = CARD_ICONS[cardType] || '\u{1F3E0}';
  const title = CARD_TITLES[cardType] || (msg.body || 'System Message');
  const titleColor = CARD_TITLE_COLORS[cardType] || '#1E3A2F';

  let bodyHTML;
  const cd = msg.card_data || {};

  if (cardType === 'clean_assigned') {
    const property = escHtml(cd.property || getCurrentPropertyName());
    const date = escHtml(cd.date || '');
    const cleanType = escHtml(cd.clean_type || 'Checkout clean');
    const guest = escHtml(cd.guest || '');
    const guestCount = cd.guest_count || '';
    const nights = cd.nights || '';
    const parts = [];
    if (property) parts.push(`<strong style="color:#333">${property}</strong>`);
    if (date || cleanType) parts.push('\u{1F4C5} ' + [date, cleanType].filter(Boolean).join(' \u00B7 '));
    if (guest) {
      let guestLine = '\u{1F464} ' + guest;
      if (guestCount) guestLine += ' \u00B7 ' + guestCount + ' guests';
      if (nights) guestLine += ' \u00B7 ' + nights + ' nights';
      parts.push(guestLine);
    }
    bodyHTML = parts.join('<br>');
  } else if (cardType === 'clean_confirmed') {
    bodyHTML = escHtml(cd.message || cd.arriving || 'Confirmed');
  } else if (cardType === 'clean_declined') {
    bodyHTML = escHtml(cd.reason || 'The cleaner declined this assignment.');
  } else if (cardType === 'clean_complete') {
    const completedAt = escHtml(cd.completed_at || '');
    const duration = escHtml(cd.duration || '');
    const parts = [];
    if (completedAt) parts.push('Completed at ' + completedAt);
    if (duration) parts.push('Duration: ' + duration);
    bodyHTML = parts.join(' \u00B7 ') || escHtml(msg.body || 'Clean complete');
  } else if (cardType === 'maintenance_flag') {
    const issue = escHtml(cd.issue || cd.description || '');
    const reporter = escHtml(cd.reported_by || '');
    const parts = [];
    if (issue) parts.push(issue);
    if (reporter) parts.push('Reported by ' + reporter);
    bodyHTML = parts.join('<br>');
    if (cd.actionable !== false) {
      bodyHTML += `<div style="margin-top:6px;font-size:11.5px;font-weight:700;color:#1E3A2F;cursor:pointer">Create maintenance task &rarr;</div>`;
    }
  } else {
    bodyHTML = escHtml(msg.body || '');
  }

  return `
    <div style="align-self:center;width:92%;border-radius:10px;margin:6px 0;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
      <div style="height:4px;border-radius:10px 10px 0 0;background:${gradient}"></div>
      <div style="padding:10px 14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:16px">${icon}</span>
          <span style="font-weight:700;font-size:13px;color:${titleColor}">${escHtml(title)}</span>
        </div>
        <div style="font-size:12.5px;color:#666;line-height:1.55">${bodyHTML}</div>
      </div>
    </div>
  `;
}

function _renderPhotoBubble(msg) {
  const isHost = msg.sender_type === 'host';
  const align = isHost ? 'flex-end' : 'flex-start';
  const capBg = isHost ? '#DCF8C6' : '#fff';
  const timeColor = isHost ? '#7D8B78' : '#999';
  const ticks = isHost ? `<span style="font-size:13px;color:#53BDEB">\u2713\u2713</span>` : '';

  return `
    <div style="align-self:${align};max-width:65%;border-radius:10px;overflow:hidden;margin:3px 0;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
      <div style="width:100%;height:170px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
        <img src="${escHtml(msg.attachment_url)}" style="width:100%;height:100%;object-fit:cover" alt="Photo" onerror="this.style.display='none';this.parentNode.style.background='linear-gradient(135deg,#e8f5e9,#c8e6c9)';this.parentNode.innerHTML='<div style=font-size:48px;opacity:0.6>\u{1F4F7}</div>'">
      </div>
      ${msg.body ? `<div style="padding:5px 8px;font-size:12px;color:#333;background:${capBg}">${escHtml(msg.body)}<div style="display:flex;justify-content:flex-end;align-items:center;gap:3px;margin-top:1px"><span style="font-size:10.5px;color:${timeColor}">${escHtml(_formatTime(msg.created_at))}</span>${ticks}</div></div>` : `<div style="padding:5px 8px;background:${capBg}"><div style="display:flex;justify-content:flex-end;align-items:center;gap:3px"><span style="font-size:10.5px;color:${timeColor}">${escHtml(_formatTime(msg.created_at))}</span>${ticks}</div></div>`}
    </div>
  `;
}

// ── 13. OPEN CHAT ───────────────────────────────────────────────────────────

export async function openChat(cleanerId) {
  _chatOpen = true;
  _dismissPreview();

  const panel = document.getElementById('stayops-chat-panel');
  if (panel) {
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
  }

  if (cleanerId) {
    _chatView = 'thread';
    _activeThread = cleanerId;
    await renderChatThread(cleanerId);
  } else {
    _chatView = 'list';
    _activeThread = null;
    await renderConversationList();
  }
}

// ── 14. CLOSE CHAT ──────────────────────────────────────────────────────────

export function closeChat() {
  _chatOpen = false;
  _chatView = 'list';
  _activeThread = null;
  const panel = document.getElementById('stayops-chat-panel');
  if (panel) panel.style.display = 'none';
}

// ── 15. UPDATE UNREAD BADGE ─────────────────────────────────────────────────

async function _updateUnreadBadge() {
  try {
    const user = await getCurrentSupabaseUser();
    const sb = _sb();
    if (!user || !sb) return;

    const { count, error } = await sb
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .neq('sender_type', 'host')
      .is('read_at', null);

    if (error) {
      console.warn('[StayOps Messaging] _updateUnreadBadge error:', error.message);
      return;
    }

    _unreadTotal = count || 0;
    _renderBadgeCount();
  } catch (err) {
    console.warn('[StayOps Messaging] _updateUnreadBadge error:', err);
  }
}

function _renderBadgeCount() {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;

  if (_unreadTotal > 0) {
    badge.style.display = 'flex';
    badge.textContent = _unreadTotal > 99 ? '99+' : String(_unreadTotal);
  } else {
    badge.style.display = 'none';
    badge.textContent = '';
  }
}

// ── 16. SHOW PREVIEW ────────────────────────────────────────────────────────

function _showPreview(msg) {
  const nameEl = document.getElementById('chat-preview-name');
  const msgEl = document.getElementById('chat-preview-msg');
  const container = document.getElementById('chat-preview');
  if (!nameEl || !msgEl || !container) return;

  const name = _getCleanerName(msg.cleaner_id);
  nameEl.textContent = name;

  let preview = msg.body || '';
  if (msg.message_type === 'photo') preview = '\u{1F4F7} Photo';
  if (msg.message_type === 'card') preview = CARD_TITLES[msg.card_type] || msg.body || 'Update';
  msgEl.textContent = preview;

  container.style.display = 'block';
  container.onclick = function () {
    openChat(msg.cleaner_id);
  };

  // Auto-dismiss after 5 seconds
  if (_previewTimer) clearTimeout(_previewTimer);
  _previewTimer = setTimeout(() => {
    _dismissPreview();
  }, 5000);
}

function _dismissPreview() {
  const container = document.getElementById('chat-preview');
  if (container) container.style.display = 'none';
  if (_previewTimer) {
    clearTimeout(_previewTimer);
    _previewTimer = null;
  }
}

// ── DOM APPEND HELPER ───────────────────────────────────────────────────────

function _appendMessageToDOM(msg) {
  const area = document.getElementById('chat-messages-area');
  if (!area) return;

  const div = document.createElement('div');
  div.innerHTML = _renderMessageBubble(msg);
  const child = div.firstElementChild;
  if (child) area.appendChild(child);

  // Scroll to bottom
  area.scrollTop = area.scrollHeight;
}

// ── INTERNAL: SEND FROM INPUT ───────────────────────────────────────────────

async function _sendFromInput() {
  const field = document.getElementById('chat-input-field');
  if (!field || !_activeThread) return;

  const body = field.value.trim();
  if (!body) return;

  field.value = '';
  await sendMessage(_activeThread, body, null);
}

async function _chatPhotoSelected(inputEl) {
  if (!inputEl || !inputEl.files || !inputEl.files[0] || !_activeThread) return;

  const file = inputEl.files[0];
  inputEl.value = '';

  // Upload and send
  const url = await uploadChatPhoto(file);
  if (url) {
    await sendMessage(_activeThread, '', url);
  }
}

function _backToList() {
  _chatView = 'list';
  _activeThread = null;
  renderConversationList();
}

// ── GLOBAL BINDINGS (for onclick in innerHTML) ──────────────────────────────

window._stayOpsOpenChat = function (cleanerId) { openChat(cleanerId); };
window._stayOpsCloseChat = function () { closeChat(); };
window._stayOpsOpenThread = function (cleanerId) {
  _chatView = 'thread';
  _activeThread = cleanerId;
  renderChatThread(cleanerId);
};
window._stayOpsBackToList = _backToList;
window._stayOpsSendFromInput = _sendFromInput;
window._stayOpsChatPhotoSelected = _chatPhotoSelected;

// ── EXPORTS ─────────────────────────────────────────────────────────────────
export {
  openChat as openChatPanel,
  closeChat as closeChatPanel,
};
