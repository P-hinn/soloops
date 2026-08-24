import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/api'

const routes = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'dashboard', component: () => import('@/views/DashboardView.vue') },
  { path: '/calendar', name: 'calendar', component: () => import('@/views/CalendarView.vue'), meta: { fullBleed: true } },
  { path: '/meetings', name: 'meetings', component: () => import('@/views/MeetingsView.vue') },
  { path: '/meetings/:id', name: 'meeting', component: () => import('@/views/MeetingDetailView.vue') },
  { path: '/notes', name: 'notes', component: () => import('@/views/NotesView.vue') },
  { path: '/projects', name: 'projects', component: () => import('@/views/ProjectsView.vue') },
  { path: '/projects/:id', name: 'project', component: () => import('@/views/ProjectDetailView.vue') },
  { path: '/clients', name: 'clients', component: () => import('@/views/ClientsView.vue') },
  { path: '/time', name: 'time', component: () => import('@/views/TimeView.vue') },
  { path: '/invoices', name: 'invoices', component: () => import('@/views/InvoicesView.vue') },
  { path: '/invoices/:id', name: 'invoice', component: () => import('@/views/InvoiceDetailView.vue') },
  { path: '/ops', name: 'ops', component: () => import('@/views/OpsView.vue') },
  { path: '/accounting', name: 'accounting', component: () => import('@/views/AccountingView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  if (!to.meta.public && !getToken()) return { name: 'login' }
  if (to.name === 'login' && getToken()) return { name: 'dashboard' }
  return true
})
