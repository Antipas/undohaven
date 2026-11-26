/* UndoHaven settings tab. Classic script: registers a lazy factory with the dsh client loader. */
(function (global) {
  var loader = global.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return
  loader.load({
    id: 'dsh-undohaven',
    factory: function (require) {
      var React = require('react')
      function bi(zh, en) {
        return React.createElement('span', null, zh, React.createElement('span', { style: { display: 'block', opacity: 0.7, fontSize: '12px' } }, en))
      }
      function Tab() {
        var statusState = React.useState(null)
        var listState = React.useState([])
        var msgState = React.useState(null)
        var passState = React.useState('')
        var apiState = React.useState('')
        var codeState = React.useState(null)
        var busyState = React.useState(false)
        var status = statusState[0]
        var setStatus = statusState[1]
        var snapshots = listState[0]
        var setSnapshots = listState[1]
        var message = msgState[0]
        var setMessage = msgState[1]
        var passphrase = passState[0]
        var setPassphrase = passState[1]
        var apiBase = apiState[0]
        var setApiBase = apiState[1]
        var code = codeState[0]
        var setCode = codeState[1]
        var busy = busyState[0]
        var setBusy = busyState[1]
        var sessionState = React.useState('')
        var sessionId = sessionState[0]
        var setSessionId = sessionState[1]
        var token = ''
        function authHeaders(extra) {
          var headers = {}
          if (token) headers['x-undohaven-token'] = token
          if (extra) {
            for (var key in extra) headers[key] = extra[key]
          }
          return headers
        }

        function refresh() {
          return fetch('/api/undohaven/status', { headers: authHeaders() }).then(function (res) { return res.json() }).then(function (body) {
            setStatus(body)
            if (body.apiBase) setApiBase(body.apiBase)
          }).catch(function (error) {
            setMessage(String(error.message || error))
          })
        }
        function refreshList() {
          return fetch('/api/undohaven/snapshots', { headers: authHeaders() }).then(function (res) { return res.json() }).then(function (body) {
            setSnapshots(body.snapshots || [])
          }).catch(function () { setSnapshots([]) })
        }
        React.useEffect(function () {
          fetch('/api/undohaven/token').then(function (res) { return res.json() }).then(function (body) {
            token = body.token || ''
            return Promise.all([refresh(), refreshList()])
          }).catch(function (error) { setMessage(String(error.message || error)) })
        }, [])

        function backup() {
          setBusy(true)
          fetch('/api/undohaven/snapshot', { method: 'POST', headers: authHeaders() }).then(function (res) { return res.json() }).then(function (body) {
            setMessage(body.ok ? '已备份 / Snapshot saved: ' + body.id : (body.error || 'failed'))
            return refreshList()
          }).finally(function () { setBusy(false) })
        }
        function planRestore(id, scope) {
          var body = { id: id, scope: scope || 'all' }
          if (body.scope === 'session') {
            if (!sessionId) {
              setMessage('请填写会话编号 / Enter a session id')
              return
            }
            body.session = sessionId
          }
          fetch('/api/undohaven/restore-plan', { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) })
            .then(function (res) { return res.json() })
            .then(function (payload) { setMessage((payload.zh || '') + ' ' + (payload.en || '') + ' ' + (payload.command || '')) })
        }
        function startLogin() {
          setBusy(true)
          fetch('/api/undohaven/login/start', { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ apiBase: apiBase }) })
            .then(function (res) { return res.json() })
            .then(function (body) {
              if (body.error) { setMessage((body.zh || '') + ' / ' + (body.en || '')); return }
              setCode(body)
              setMessage((body.user_code || '') + ' ' + (body.verification_uri || ''))
            })
            .finally(function () { setBusy(false) })
        }
        function poll() {
          fetch('/api/undohaven/login/poll', { headers: authHeaders() }).then(function (res) { return res.json() }).then(function (body) {
            setMessage(body.pending ? '等待授权 / Waiting for approval' : '已授权，输入口令 / Authorized, enter the passphrase')
            if (!body.pending) setCode(Object.assign({}, code || {}, { authorized: true }))
          })
        }
        function finish() {
          setBusy(true)
          fetch('/api/undohaven/login/finish', { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ passphrase: passphrase }) })
            .then(function (res) { return res.json() })
            .then(function (body) {
              var words = body.recoveryWords ? body.recoveryWords.join(' ') : ''
              setMessage((body.zh || '') + ' / ' + (body.en || '') + (words ? ' ' + words : ''))
              setPassphrase('')
              return refresh()
            })
            .finally(function () { setBusy(false) })
        }

        var rows = (snapshots || []).slice(-12).reverse().map(function (row) {
          return React.createElement('li', { key: row.id, style: { margin: '8px 0' } },
            React.createElement('code', null, row.id),
            ' ',
            row.kind,
            ' ',
            row.createdAt,
            ' ',
            React.createElement('button', { type: 'button', onClick: function () { planRestore(row.id, 'all') } }, '恢复向导 / Restore wizard'),
            ' ',
            React.createElement('button', { type: 'button', onClick: function () { planRestore(row.id, 'tasks') } }, '只恢复定时任务 / Restore only scheduled tasks'),
            ' ',
            React.createElement('button', { type: 'button', onClick: function () { planRestore(row.id, 'session') } }, '恢复这个会话 / Restore this session'))
        })
        return React.createElement('section', { style: { display: 'grid', gap: '12px', maxWidth: '720px' } },
          React.createElement('h2', { style: { margin: 0 } }, 'UndoHaven'),
          React.createElement('p', { style: { margin: 0, opacity: 0.75 } }, '后悔药'),
          React.createElement('p', null, bi(
            status ? (status.zh || '') : '正在读取',
            status ? (status.en || '') : 'Loading'
          )),
          React.createElement('p', null, React.createElement('a', { href: 'https://undohaven.com/pricing?utm_source=plugin' }, 'Pro'), ' · ', React.createElement('a', { href: 'https://undohaven.com/zh/pricing?utm_source=plugin' }, '专业版')),
          status && status.upgrade ? React.createElement('p', null, (status.upgrade.zh || '') + ' / ' + (status.upgrade.en || '') + ' https://undohaven.com/pricing?utm_source=plugin') : null,
          status && status.lastError ? React.createElement('p', null, status.lastError) : null,
          message ? React.createElement('p', null, message) : null,
          React.createElement('p', null, bi(
            '删除前多一层留底。不能保证每次误删都能找回来。命令是 /undohaven restore-deleted。',
            'Extra backup layer before a delete. This does not guarantee every accidental delete can be restored. Command: /undohaven restore-deleted.'
          )),
          status && status.alignment && status.alignment.plugins && status.alignment.plugins.length ? React.createElement('p', null, (status.alignment.zh || '') + ' / ' + (status.alignment.en || '') + ' ' + status.alignment.plugins.map(function (plugin) { return plugin.name }).join(', ')) : null,
          status && status.alignment && status.alignment.plugins && status.alignment.plugins.length ? React.createElement('button', { type: 'button', disabled: busy, onClick: function () {
            setBusy(true)
            fetch('/api/undohaven/align', { method: 'POST', headers: authHeaders() }).then(function (res) { return res.json() }).then(function (body) {
              setMessage((body.zh || '') + ' / ' + (body.en || '') + ' ' + (body.snapshotId || ''))
            }).finally(function () { setBusy(false) })
          } }, '先快照再对齐 / Snapshot, then realign') : null,
          React.createElement('button', { type: 'button', disabled: busy, onClick: backup }, '立即备份 / Back up now'),
          React.createElement('ul', null, rows.length ? rows : React.createElement('li', null, bi('还没有快照', 'No snapshots yet'))),
          React.createElement('label', null, bi('会话编号', 'Session id'),
            React.createElement('input', { value: sessionId, onChange: function (event) { setSessionId(event.target.value) }, style: { display: 'block', width: '100%', marginTop: '4px' } })),
          React.createElement('label', null, bi('服务地址', 'Service URL'),
            React.createElement('input', { value: apiBase, onChange: function (event) { setApiBase(event.target.value) }, style: { display: 'block', width: '100%', marginTop: '4px' } })),
          React.createElement('button', { type: 'button', disabled: busy, onClick: startLogin }, '登录 / Log in'),
          code ? React.createElement('p', null, (code.user_code || '') + ' ', React.createElement('a', { href: code.verification_uri, target: '_blank', rel: 'noreferrer' }, code.verification_uri || '')) : null,
          React.createElement('button', { type: 'button', onClick: poll }, '我已授权 / I approved it'),
          React.createElement('label', null, bi('口令', 'Passphrase'),
            React.createElement('input', { type: 'password', value: passphrase, onChange: function (event) { setPassphrase(event.target.value) }, style: { display: 'block', width: '100%', marginTop: '4px' } })),
          React.createElement('button', { type: 'button', disabled: busy, onClick: finish }, '解锁 / Unlock'),
          React.createElement('p', { style: { opacity: 0.75 } }, bi(
            '口令只发给本机的 dsh，不会上传。恢复要先退出 dsh，再用命令行完成。',
            'The passphrase is sent only to dsh on this machine. Restore waits until dsh has quit, then the CLI finishes it.'
          )))
      }
      return {
        name: 'dsh-undohaven',
        inject: ['slots'],
        apply: function (ctx) {
          ctx.slots.inject('settings.plugins.tab', function () {
            return ctx.slots.register({
              name: 'settings.plugins.tab',
              id: 'undohaven',
              order: 80,
              label: 'UndoHaven / 后悔药',
            }, Tab)
          })
        },
      }
    },
  })
})(typeof globalThis !== 'undefined' ? globalThis : this)
