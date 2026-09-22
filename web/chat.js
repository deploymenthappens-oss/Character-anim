/* Chat client (classic script, exposes window.Chat). Talks to /events (SSE) and POST /chat. */
(function () {
  'use strict';
  class Chat {
    constructor({ log, name, msg, send, status, onReply, onComment, onMode, onInterrupt, onVoice, onPending,
                  onGesture, onBackground, onMotion, onSpeechState }) {
      this.logEl = log; this.nameEl = name; this.msgEl = msg; this.sendEl = send;
      this.statusEl = status || null; this.onReply = onReply || null; this.onComment = onComment || null;
      this.onMode = onMode || null; this.onInterrupt = onInterrupt || null; this.onVoice = onVoice || null;
      this.onPending = onPending || null;
      // Pure-virtual viewer broadcasts (view.html): the admin's gesture/background/motion/speech-stop
      // controls, all delivered on this same /events connection - no separate stream needed.
      this.onGesture = onGesture || null; this.onBackground = onBackground || null;
      this.onMotion = onMotion || null; this.onSpeechState = onSpeechState || null;
    }
    init() {
      let saved = '';
      try { saved = localStorage.getItem('chatName') || ''; } catch {}
      this.nameEl.value = saved || 'guest' + Math.floor(100 + Math.random() * 900);
      this.nameEl.addEventListener('change', () => { try { localStorage.setItem('chatName', this.nameEl.value); } catch {} });
      this.sendEl.addEventListener('click', () => this.send());
      this.msgEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.send(); } });
      this.connect();
    }
    setState(t) { if (this.statusEl) this.statusEl.textContent = t; }
    connect() {
      const es = new EventSource('events');
      es.addEventListener('open', () => this.setState('chat connected'));
      es.addEventListener('error', () => this.setState('chat reconnecting…'));
      es.addEventListener('history', e => {
        const d = JSON.parse(e.data);
        this.logEl.textContent = '';
        d.items.forEach(m => this.render(m));
        if (this.onMode) this.onMode(d);
        if (this.onVoice && d.voice) this.onVoice(d.voice);
      });
      es.addEventListener('chat', e => {
        const m = JSON.parse(e.data);
        this.render(m);
        if (this.onComment) this.onComment(m);      // a viewer's comment (from any page) arrived
      });
      es.addEventListener('reply', e => {
        const m = JSON.parse(e.data);
        this.render(m);
        if (this.onReply) this.onReply(m);
      });
      // Event-driven interruption from the server: a real comment beat the baseline script. Client
      // pages use this to cut the currently-playing audio/mouth movement off immediately.
      es.addEventListener('interrupt', () => { if (this.onInterrupt) this.onInterrupt(); });
      // Comments held in the moderation memory (repliesMode 'review', or a script-protected interrupt) -
      // a full snapshot each time one is added/approved/rejected, for the publisher's control panel.
      es.addEventListener('pending', e => { if (this.onPending) this.onPending(JSON.parse(e.data).items || []); });
      // Admin broadcasts for the event-driven avatar (see chat/server.js POST /gesture, /background,
      // /motion, /speech/pause|resume): every connected viewer reacts to the same small JSON events.
      es.addEventListener('gesture', e => { if (this.onGesture) this.onGesture(JSON.parse(e.data)); });
      es.addEventListener('background', e => { if (this.onBackground) this.onBackground(JSON.parse(e.data)); });
      es.addEventListener('motion', e => { if (this.onMotion) this.onMotion(JSON.parse(e.data)); });
      es.addEventListener('speech-state', e => { if (this.onSpeechState) this.onSpeechState(JSON.parse(e.data)); });
    }
    render(m) {
      const line = document.createElement('div');
      line.className = 'msg' + (m.avatar ? ' bot' : '') + (m.baseline || m.ack ? ' baseline' : '') + (m.silent ? ' silent' : '');
      const who = document.createElement('b');
      who.textContent = (m.baseline ? 'Avatar · script' : m.name) + (m.silent ? ' (text only)' : '');
      line.append(who, ' ', document.createTextNode(m.text));      // textContent only: no HTML injection
      this.logEl.appendChild(line);
      while (this.logEl.children.length > 100) this.logEl.firstChild.remove();
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
    async send() {
      const text = this.msgEl.value.trim();
      if (!text) return;
      const name = (this.nameEl.value || 'guest').trim();
      this.msgEl.value = '';
      try {
        const r = await fetch('chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text }) });
        if (r.status === 429) this.render({ name: '•', text: 'Slow down a little.' });
        else if (!r.ok) this.render({ name: '•', text: 'Message failed (HTTP ' + r.status + ')' });
      } catch (e) { this.render({ name: '•', text: 'Message failed: ' + e.message }); }
    }
  }
  window.Chat = Chat;
})();
