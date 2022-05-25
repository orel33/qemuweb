<template>
    <div>
        <NodeHeader  title="PC"/>
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'
import NodeHeader from './NodeHeader.vue'

export default defineComponent({
    components: {
        NodeHeader
    }
    
})
</script>
