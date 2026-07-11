import { createRouter, createWebHashHistory } from 'vue-router'
import Landing from './views/Landing.vue'
import Room from './views/Room.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'landing', component: Landing },
    { path: '/room/:id', name: 'room', component: Room, props: true }
  ]
})
