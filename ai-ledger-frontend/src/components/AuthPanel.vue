<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useQuasar } from 'quasar'
import {
  changePassword,
  ensureAuthReady,
  signInWithPassword,
  signOut,
  subscribeAuthChanges,
} from '../services/authService'
import { getCloudApiConfigHint, isCloudApiConfigured } from '../services/cloudApiClient'

const emit = defineEmits(['auth-changed'])
const $q = useQuasar()

const isCloudAvailable = computed(() => isCloudApiConfigured())
const authUser = ref(null)
const usernameInput = ref('')
const passwordInput = ref('')
const currentPasswordInput = ref('')
const newPasswordInput = ref('')
const confirmNewPasswordInput = ref('')
const isSigningIn = ref(false)
const isChangingPassword = ref(false)
const isSigningOut = ref(false)
const authMessage = ref({ type: '', text: '' })

let unsubscribeAuth = null

const userLabel = computed(() => {
  if (!authUser.value) {
    return ''
  }
  return authUser.value.username || authUser.value.id
})

/**
 * 设置认证反馈提示。
 *
 * @param {'success' | 'error' | ''} type 消息类型。
 * @param {string} text 消息文本。
 * @returns {void} 无返回值。
 */
function setAuthMessage(type, text) {
  authMessage.value = { type, text }
}

/**
 * 清空登录表单输入。
 *
 * @returns {void} 无返回值。
 */
function resetSignInForm() {
  passwordInput.value = ''
}

/**
 * 清空改密表单输入。
 *
 * @returns {void} 无返回值。
 */
function resetChangePasswordForm() {
  currentPasswordInput.value = ''
  newPasswordInput.value = ''
  confirmNewPasswordInput.value = ''
}

/**
 * 初始化认证状态并订阅后续变化。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function initAuthPanel() {
  unsubscribeAuth = subscribeAuthChanges((user) => {
    authUser.value = user
    emit('auth-changed', user)

    if (user) {
      resetSignInForm()
      setAuthMessage('success', '已登录，云同步已启用')
      return
    }

    resetChangePasswordForm()
    setAuthMessage('', '')
  })
  await ensureAuthReady()
}

/**
 * 账号密码登录。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleSignIn() {
  const username = usernameInput.value.trim().toLowerCase()
  const password = passwordInput.value.trim()
  if (!username) {
    setAuthMessage('error', '请先输入账号')
    return
  }
  if (!password) {
    setAuthMessage('error', '请先输入密码')
    return
  }

  isSigningIn.value = true
  try {
    await signInWithPassword(username, password)
    setAuthMessage('success', '登录成功')
    $q.notify({
      type: 'positive',
      message: '登录成功，正在同步云端数据',
      position: 'top',
      timeout: 1800,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '登录失败'
    setAuthMessage('error', message)
  } finally {
    isSigningIn.value = false
  }
}

/**
 * 修改当前账号密码。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleChangePassword() {
  const currentPassword = currentPasswordInput.value.trim()
  const newPassword = newPasswordInput.value.trim()
  const confirmNewPassword = confirmNewPasswordInput.value.trim()

  if (!currentPassword) {
    setAuthMessage('error', '请输入当前密码')
    return
  }
  if (!newPassword) {
    setAuthMessage('error', '请输入新密码')
    return
  }
  if (newPassword.length < 8) {
    setAuthMessage('error', '新密码至少 8 位')
    return
  }
  if (newPassword !== confirmNewPassword) {
    setAuthMessage('error', '两次输入的新密码不一致')
    return
  }

  isChangingPassword.value = true
  try {
    await changePassword(currentPassword, newPassword)
    resetChangePasswordForm()
    setAuthMessage('success', '密码修改成功')
  } catch (error) {
    const message = error instanceof Error ? error.message : '密码修改失败'
    setAuthMessage('error', message)
  } finally {
    isChangingPassword.value = false
  }
}

/**
 * 退出当前账号。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function handleSignOut() {
  isSigningOut.value = true
  try {
    await signOut()
    setAuthMessage('success', '已退出登录，当前为本地模式')
  } catch (error) {
    const message = error instanceof Error ? error.message : '退出登录失败'
    setAuthMessage('error', message)
  } finally {
    isSigningOut.value = false
  }
}

onMounted(async () => {
  try {
    await initAuthPanel()
  } catch (error) {
    const message = error instanceof Error ? error.message : '认证模块初始化失败'
    setAuthMessage('error', message)
  }
})

onBeforeUnmount(() => {
  if (typeof unsubscribeAuth === 'function') {
    unsubscribeAuth()
  }
})
</script>

<template>
  <q-card flat bordered class="auth-card">
    <q-card-section class="auth-body">
      <div class="auth-header">
        <div>
          <p class="auth-title">账号与云同步</p>
          <p class="auth-subtitle">登录后自动同步账单、类别预设与 AI 配置</p>
        </div>
        <q-chip
          dense
          :color="authUser ? 'positive' : 'grey-7'"
          text-color="white"
          :label="authUser ? '已登录' : '未登录'"
        />
      </div>

      <q-banner v-if="!isCloudAvailable" rounded dense class="bg-orange-1 text-orange-10">
        {{ getCloudApiConfigHint() }}
      </q-banner>

      <template v-if="isCloudAvailable">
        <div v-if="authUser" class="signed-user-row">
          <div class="signed-user-meta">
            <span class="signed-user-label">当前账号</span>
            <span class="signed-user-value">{{ userLabel }}</span>
          </div>
          <q-btn
            unelevated
            color="negative"
            no-caps
            label="退出登录"
            :loading="isSigningOut"
            @click="handleSignOut"
          />
        </div>

        <div v-if="authUser" class="change-password-grid">
          <q-input
            v-model="currentPasswordInput"
            filled
            type="password"
            autocomplete="current-password"
            label="当前密码"
            placeholder="请输入当前密码"
          />
          <q-input
            v-model="newPasswordInput"
            filled
            type="password"
            autocomplete="new-password"
            label="新密码"
            placeholder="至少 8 位"
          />
          <q-input
            v-model="confirmNewPasswordInput"
            filled
            type="password"
            autocomplete="new-password"
            label="确认新密码"
            placeholder="请再次输入新密码"
            @keyup.enter="handleChangePassword"
          />
          <q-btn
            unelevated
            color="secondary"
            no-caps
            :loading="isChangingPassword"
            label="修改密码"
            @click="handleChangePassword"
          />
        </div>

        <div v-else class="auth-form-grid">
          <q-input
            v-model="usernameInput"
            filled
            type="text"
            autocomplete="username"
            label="账号"
            placeholder="请输入账号"
          />
          <q-input
            v-model="passwordInput"
            filled
            type="password"
            autocomplete="current-password"
            label="密码"
            placeholder="请输入密码"
            @keyup.enter="handleSignIn"
          />
          <q-btn
            unelevated
            color="primary"
            no-caps
            :loading="isSigningIn"
            label="登录"
            @click="handleSignIn"
          />
        </div>
      </template>

      <q-banner
        v-if="authMessage.text"
        rounded
        dense
        :class="authMessage.type === 'error' ? 'bg-negative text-white' : 'bg-positive text-white'"
      >
        {{ authMessage.text }}
      </q-banner>
    </q-card-section>
  </q-card>
</template>

<style scoped>
.auth-card {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(8px);
}

.auth-body {
  display: grid;
  gap: 0.65rem;
}

.auth-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
}

.auth-title {
  margin: 0;
  color: #0f172a;
  font-size: 0.95rem;
  font-weight: 700;
}

.auth-subtitle {
  margin: 0.1rem 0 0;
  color: #475569;
  font-size: 0.84rem;
}

.auth-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 0.55rem;
}

.change-password-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 0.55rem;
}

.signed-user-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
}

.signed-user-meta {
  display: grid;
  gap: 0.15rem;
}

.signed-user-label {
  color: #475569;
  font-size: 0.8rem;
}

.signed-user-value {
  color: #0f172a;
  font-size: 0.9rem;
  font-weight: 600;
  word-break: break-all;
}

@media (max-width: 980px) {
  .auth-form-grid,
  .change-password-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .signed-user-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
