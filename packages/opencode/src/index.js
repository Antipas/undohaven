import { server } from './v1.js'
import { setup } from './v2.js'

// One default export that both OpenCode generations accept:
// 1.x reads { id, server }, 2.x reads { id, setup }.
export default { id: 'undohaven', server, setup }
