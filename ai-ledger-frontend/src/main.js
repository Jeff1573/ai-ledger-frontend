import '@quasar/extras/material-icons/material-icons.css'
import 'quasar/src/css/index.sass'
import './assets/main.css'

import { createApp } from 'vue'
import { Notify, Quasar } from 'quasar'
import App from './App.vue'

const app = createApp(App)

// 统一在入口挂载 Quasar，便于后续按需扩展插件配置。
app.use(Quasar, {
  plugins: {
    Notify,
  },
})

app.mount('#app')
