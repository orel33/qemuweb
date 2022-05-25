<template>
    <div>
        <img src="../../assets/computer.png" />
        <input class="host-name" type="text" value="bob">
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'

export default defineComponent({

})
</script>

<style scoped>
img {
    width:65px;
    height:65px;
}
</style>
