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

        function refresh() {
          return fetch('/api/undohaven/status').then(function (res) { return res.json() }).then(function (body) {
            setStatus(body)
            if (body.apiBase) setApiBase(body.apiBase)
          }).catch(function (error) {
            setMessage(String(error.message || error))
          })
        }
        function refreshList() {
          return fetch('/api/undohaven/snapshots').then(function (res) { return res.json() }).then(function (body) {
            setSnapshots(body.snapshots || [])
          }).catch(function () { setSnapshots([]) })
        }
        React.useEffect(function () {
          refresh()
          refreshList()
        }, [])

        function backup() {
          setBusy(true)
          fetch('/api/undohaven/snapshot', { method: 'POST' }).then(function (res) { return res.json() }).then(function (body) {
            setMessage(body.ok ? '已备份 / Snapshot saved: ' + body.id : (body.error || 'failed'))
            return refreshList()
          }).finally(function () { setBusy(false) })
        }
        function planRestore(id) {
          fetch('/api/undohaven/restore-plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, scope: 'all' }) })
            .then(function (res) { return res.json() })
            .then(function (body) { setMessage((body.zh || '') + ' ' + (body.command || '')) })
        }
        function startLogin() {
          setBusy(true)
          fetch('/api/undohaven/login/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiBase: apiBase }) })
            .then(function (res) { return res.json() })
            .then(function (body) {
              if (body.error) { setMessage((body.zh || '') + ' / ' + (body.en || '')); return }
              setCode(body)
              setMessage((body.user_code || '') + ' ' + (body.verification_uri || ''))
            })
            .finally(function () { setBusy(false) })
        }
        function poll() {
          fetch('/api/undohaven/login/poll').then(function (res) { return res.json() }).then(function (body) {
            setMessage(body.pending ? '等待授权 / Waiting for approval' : '已授权，输入口令 / Authorized, enter the passphrase')
            if (!body.pending) setCode(Object.assign({}, code || {}, { authorized: true }))
          })
        }
        function finish() {
          setBusy(true)
          fetch('/api/undohaven/login/finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: passphrase }) })
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
            React.createElement('button', { type: 'button', onClick: function () { planRestore(row.id) } }, '恢复向导 / Restore wizard'))
        })
        return React.createElement('section', { style: { display: 'grid', gap: '12px', maxWidth: '720px' } },
          React.createElement('h2', { style: { margin: 0 } }, 'UndoHaven'),
          React.createElement('p', { style: { margin: 0, opacity: 0.75 } }, '后悔药'),
          React.createElement('p', null, bi(
            status ? (status.zh || '') : '正在读取',
            status ? (status.en || '') : 'Loading'
          )),
          status && status.upgrade ? React.createElement('p', null, (status.upgrade.zh || '') + ' / ' + (status.upgrade.en || '')) : null,
          status && status.lastError ? React.createElement('p', null, status.lastError) : null,
          message ? React.createElement('p', null, message) : null,
          React.createElement('button', { type: 'button', disabled: busy, onClick: backup }, '立即备份 / Back up now'),
          React.createElement('ul', null, rows.length ? rows : React.createElement('li', null, bi('还没有快照', 'No snapshots yet'))),
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
