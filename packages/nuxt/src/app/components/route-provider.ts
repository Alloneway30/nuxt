import { defineComponent, h, nextTick, onMounted, provide, shallowReactive } from 'vue'
import type { Ref, VNode } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { PageRouteSymbol } from './injections'

export const defineRouteProvider = (name = 'RouteProvider') => defineComponent({
  name,
  props: {
    route: {
      type: Object as () => RouteLocationNormalizedLoaded,
      required: true,
    },
    vnode: Object as () => VNode,
    vnodeRef: Object as () => Ref<any>,
    renderKey: String,
    trackRootNodes: Boolean,
  },
  setup (props) {
    // Prevent reactivity when the page will be rerendered in a different suspense fork
    const previousKey = props.renderKey
    const previousRoute = props.route

    // Provide a reactive route within the page
    const route = {} as RouteLocationNormalizedLoaded
    for (const key in props.route) {
      Object.defineProperty(route, key, {
        get: () => previousKey === props.renderKey ? props.route[key as keyof RouteLocationNormalizedLoaded] : previousRoute[key as keyof RouteLocationNormalizedLoaded],
        enumerable: true,
      })
    }

    provide(PageRouteSymbol, shallowReactive(route))

    let vnode: VNode
    if (import.meta.dev && import.meta.client && props.trackRootNodes) {
      onMounted(() => {
        nextTick(() => {
          if (['#comment', '#text'].includes(vnode?.el?.nodeName)) {
            const filename = (vnode?.type as any)?.__file
            console.warn(`[nuxt] \`${filename}\` does not have a single root node and will cause errors when navigating between routes.`)
          }
        })
      })
    }

    return () => {
      if (!props.vnode) {
        return props.vnode
      }
      if (import.meta.dev && import.meta.client) {
        vnode = h(props.vnode, { ref: props.vnodeRef })
        return vnode
      }

      return h(props.vnode, { ref: props.vnodeRef })
    }
  },
})

export const RouteProvider = defineRouteProvider()
