<template>
    <div class="header">{{title}}</div>
</template>
<script>
import { defineComponent } from 'vue'

export default defineComponent({
    props: ['title'],
})
</script>


<style scoped>
div {
    text-align: center;
}
</style>