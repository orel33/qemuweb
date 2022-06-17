<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue';

export default {
  props: {
    show: Boolean,
    hostId: Number,
    name: String,
    distributions: Array,
    selectedDistrib: String,
    neighboors: Map,
    interfacesCount: Number
  },
  computed: {
    localSelectedDistrib: {
      get() {
        return this.selectedDistrib;
      },
      set(value) {
        this.$emit('updateSelectedDistrib', value)
      }
    },
    localName: {
      get() {
        return this.name;
      },
      set(value) {
        this.$emit('updateHostName', value)
      }
    },
    localNeighboors: {
      get() {
        return this.neighboors;
      },
      set(value) {
        this.$emit('updateNeighboors', value)
      }
    },
    localInterfacesCount: {
      get() {
        return this.interfacesCount;
      },
      set(value) {
        this.$emit('updateInterfaces', value)
      }
    },
    editor: {
      get() {
        return getCurrentInstance().appContext.app._context.config.globalProperties.$df;
      }
    }
  },
  methods: {
    loadInterfaces() {
      // Load the connections interfaces/switches in selects
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
      var switchesSelects = neighboorsDiv.querySelectorAll(".switches");
      for (let i = 0; i < this.interfacesCount; i++) {
        if (this.editor.getNodeFromId(this.hostId).outputs['output_'+(i+1)].connections.length > 0) {
          var switchId = this.editor.getNodesFromName('Switch').indexOf(Number(this.editor.getNodeFromId(this.hostId).outputs['output_'+(i+1)].connections[0].node));
          var port = this.editor.getNodeFromId(this.hostId).outputs['output_'+(i+1)].connections[0].output.split('_')[1];
          switchesSelects[i].value = (switchId+1) + ':' + port;
        }
      }
    },
    switchesChanged(index) {
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
      var switches = this.editor.getNodesFromName('Switch');
      var selectValue = neighboorsDiv.querySelectorAll(".switches")[index-1].value;
      var switchValue = selectValue.split(':')[0];
      var portValue = selectValue.split(':')[1];
      for (let connection of this.editor.getNodeFromId(this.hostId).outputs['output_'+index].connections) {
        this.editor.removeSingleConnection(this.hostId, connection.node, 'output_'+index, connection.output)
      }
      this.editor.addConnection(this.hostId, switches[switchValue-1], 'output_' + index, 'input_' + portValue);
    },
    removeInterface() {
      if (this.interfacesCount > 1) {
        this.editor.removeNodeOutput(this.hostId, 'output_' + this.interfacesCount);
        this.localInterfacesCount--;
      }
    },
    addInterface() {
      this.editor.addNodeOutput(this.hostId);
      this.localInterfacesCount++;
    },
    switchesCount() {
      return this.editor.getNodesFromName('Switch').length;
    }
  },
  updated() {
    /// Triggered when modal pop up
    if (this.show) {
      this.loadInterfaces();
    }
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-mask">
      <div class="modal-wrapper">
        <div class="modal-container">
          <div class="modal-header">
            <slot name="header">default header</slot>
          </div>

          <div :id="'modal-body-div-' + hostId" class="modal-body">
            <div class="modal-section">
              <span class="modal-span title"> System : </span>
              <select v-model="localSelectedDistrib">
                <option v-for="item in distributions" :key="item.value" :label="item.label" :value="item.value"></option>
              </select>
            </div>
            <div class="modal-section">
              <span class="modal-span title"> Name : </span>
              <input class="host-name-in-modal" type="text" v-model="localName">
            </div>
            <div class="interfaces-div modal-section">
              <span class="modal-span title"> Network interface management : </span>

              <div class="interfaces-buttons">
                <button class="interfaces-btn-minus" @click="removeInterface"> - </button>
                <button class="interfaces-btn-plus" @click="addInterface"> + </button>
              </div>

              <div class="interfaces-for" v-for="index in interfacesCount" :key="index">
                <span class="modal-span"> eth{{index-1}} -- </span>
                <select class="switches" @change="switchesChanged(index)">
                  <option label=" -- " value="-1"></option>
                  <optgroup v-for="indexS in switchesCount()" :key="indexS" :label="editor.getNodeFromId(editor.getNodesFromName('Switch')[indexS-1]).data.name">
                    <option v-for="indexP in editor.getNodeFromId(editor.getNodesFromName('Switch')[indexS-1]).data.portsCount" :key="indexP" 
                            :label="editor.getNodeFromId(editor.getNodesFromName('Switch')[indexS-1]).data.name + '/ #' + (indexP-1)" :value="indexS + ':' + indexP">
                    </option>
                  </optgroup>
                </select>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <slot name="footer">
              <button class="modal-default-button" @click="$emit('close')"> OK </button>
            </slot>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style>
.interfaces-for {
  margin-top: 10px;
}

.modal-mask {
  position: fixed;
  z-index: 9998;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: table;
  transition: opacity 0.3s ease;
}

.modal-wrapper {
  display: table-cell;
  vertical-align: middle;
}

.modal-container {
  width: 400px;
  margin: 0px auto;
  padding: 20px 30px;
  background-color: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.33);
  transition: all 0.3s ease;
}

.modal-header h2 {
  margin-top: 0;
  color: #42b983;
}

.modal-body {
  margin: 20px 0;
}

.modal-default-button {
  float: right;
}

.modal-footer {
  padding-bottom: 15px;
}

/*
 * The following styles are auto-applied to elements with
 * transition="modal" when their visibility is toggled
 * by Vue.js.
 *
 * You can easily play with the modal transition by editing
 * these styles.
 */

.modal-enter-from {
  opacity: 0;
}

.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  -webkit-transform: scale(1.1);
  transform: scale(1.1);
}
</style>