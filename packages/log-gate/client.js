/* Third-party log gate settings tab. Not an official dsh panel. */
(function (global) {
  var loader = global.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return
  loader.load({
    id: 'dsh-log-gate',
    factory: function (require) {
      var React = require('react')
      function Tab() {
        var state = React.useState(null)
        var status = state[0]
        var setStatus = state[1]
        React.useEffect(function () {
          var token = ''
          fetch('/api/log-gate/token').then(function (res) { return res.json() }).then(function (body) {
            token = body.token || ''
            return fetch('/api/log-gate/status', { headers: { 'x-undohaven-token': token } })
          }).then(function (res) { return res.json() }).then(setStatus).catch(function () { setStatus(null) })
        }, [])
        var rows = ((status && status.sessions) || []).map(function (row) {
          return React.createElement('li', { key: row.id || row.cwd }, (row.blocked ? 'blocked / 已拦住 ' : 'eligible / 会上传 ') + (row.cwd || row.id || ''))
        })
        return React.createElement('section', null,
          React.createElement('h2', null, '日志闸门'),
          React.createElement('p', null, 'Unofficial third-party plugin compatible with dsh. / 非官方第三方插件，兼容 dsh。'),
          React.createElement('p', null, status ? status.message : 'Loading / 正在读取'),
          React.createElement('ul', null, rows.length ? rows : React.createElement('li', null, 'No live sessions / 没有实时会话'))
        )
      }
      return {
        name: 'dsh-log-gate',
        inject: ['slots'],
        apply: function (ctx) {
          ctx.slots.inject('settings.plugins.tab', function () {
            return ctx.slots.register({
              name: 'settings.plugins.tab',
              id: 'log-gate',
              order: 70,
              label: '日志闸门 / Log gate',
            }, Tab)
          })
        },
      }
    },
  })
})(typeof globalThis !== 'undefined' ? globalThis : this)
