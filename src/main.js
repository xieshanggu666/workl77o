import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { ensureSeeded } from './db/seed'
import './styles/base.css'

async function bootstrap() {
  await ensureSeeded()
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
}

bootstrap()