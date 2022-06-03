<template>
    <div class="switch-component">
        <img src="../../assets/switch.png" alt="Un switch" />
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'

export default defineComponent({
    data() {
        return {
            number : -1
        }
    }
})
</script>

<style scoped>
img {
    width:65px;
    height:65px;
}
</style>