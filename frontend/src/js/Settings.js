/* eslint-disable */
import { getCurrentInstance } from 'vue';

export class Settings {
  constructor() {
    this.container = document.getElementById("settings");
    this.editor = getCurrentInstance().appContext.app._context.config.globalProperties.$df;
  }
  
  /**
   * Open the settings modal to load it in the DOM
   * Then close it instantly
   * Purpose: Make the settings modal elements be accessible via document.getElement*()
   */
  mountInDOM() {
    document.getElementsByClassName("el-overlay")[0].style.visibility = "hidden";
    document.getElementById("open-settings").click();
    setTimeout(() => {  document.getElementsByClassName("el-dialog__headerbtn")[0].click(); }, 50);
    setTimeout(() => {  document.getElementsByClassName("el-overlay")[0].style.visibility = ""; }, 300);
  }
  
  /**
   * Set the value of the option name
   * @param {String} name the name of the option
   * @param {*} value the value of the option
   */
  setOption(name, value) {
    this.container.setAttribute("data-" + name, value);
  }
  
  /**
   * Get the value of the option name
   * @param {String} name the name of the option
   * @returns the value of the option
   */
  getOption(name) {
    return this.container.getAttribute("data-" + name);
  }
  
  /**
   * Get the boolean value of the option name
   * @param {String} name the name of a boolean option
   * @returns the boolean value of the option
   */
  getOptionBool(name) {
    return this.container.getAttribute("data-" + name) == "true";
  }
  
  /**
   * Enable/Disable the interfaces name display
   */
  changeDisplayInterfacesName() {
    var checked = document.getElementById("interfaces-name-check").checked;
    var display = checked ? "block" : "none";
    this.setOption("display-interfaces-name", checked);
    var interfaces = document.querySelectorAll(".drawflow-node.Host .outputs .output");
    for (const el of interfaces) {
      el.style.setProperty('--vardisplay', display);
    }
  }
  
  /**
   * Enable/Disable the ports name display
   */
  changeDisplayPortsName() {
    var checked = document.getElementById("ports-name-check").checked;
    var display = checked ? "block" : "none";
    this.setOption("display-ports-name", checked);
    var ports = document.querySelectorAll(".drawflow-node.Switch .inputs .input");
    for (const el of ports) {
      el.style.setProperty('--vardisplay', display);
    }
  }
  
  /**
   * Refresh the display of the connections
   */
  refreshNodeDisplay() {
    var allNodes = this.editor.getNodesFromName('Host').concat(this.editor.getNodesFromName('Switch'));
    for (let id of allNodes) {
      this.editor.updateConnectionNodes("node-" + id);
    }
  }
  
  /**
   * Enable/Disable the curved in connections 
   */
  changeCurvedConnections() {
    var checked = document.getElementById("curved-check").checked;
    this.setOption("curved-connections", checked);
    if (checked) {
      // Make lines curved
      this.editor.curvature = 0.5
      this.editor.reroute_curvature_start_end = 0.5
      this.editor.reroute_curvature = 0.5
      this.editor.createCurvature = function(start_pos_x, start_pos_y, end_pos_x, end_pos_y, curvature_value, type) {
        var line_x = start_pos_x;
        var line_y = start_pos_y;
        var x = end_pos_x;
        var y = end_pos_y;
        var curvature = curvature_value;
        //type openclose open close other
        switch (type) {
          case 'open':
          if(start_pos_x >= end_pos_x) {
            var hx1 = line_x + Math.abs(x - line_x) * curvature;
            var hx2 = x - Math.abs(x - line_x) * (curvature*-1);
          } else {
            var hx1 = line_x + Math.abs(x - line_x) * curvature;
            var hx2 = x - Math.abs(x - line_x) * curvature;
          }
          return ' M '+ line_x +' '+ line_y +' C '+ hx1 +' '+ line_y +' '+ hx2 +' ' + y +' ' + x +'  ' + y;
          
          break
          case 'close':
          if(start_pos_x >= end_pos_x) {
            var hx1 = line_x + Math.abs(x - line_x) * (curvature*-1);
            var hx2 = x - Math.abs(x - line_x) * curvature;
          } else {
            var hx1 = line_x + Math.abs(x - line_x) * curvature;
            var hx2 = x - Math.abs(x - line_x) * curvature;
          }
          return ' M '+ line_x +' '+ line_y +' C '+ hx1 +' '+ line_y +' '+ hx2 +' ' + y +' ' + x +'  ' + y;
          break;
          case 'other':
          if(start_pos_x >= end_pos_x) {
            var hx1 = line_x + Math.abs(x - line_x) * (curvature*-1);
            var hx2 = x - Math.abs(x - line_x) * (curvature*-1);
          } else {
            var hx1 = line_x + Math.abs(x - line_x) * curvature;
            var hx2 = x - Math.abs(x - line_x) * curvature;
          }
          return ' M '+ line_x +' '+ line_y +' C '+ hx1 +' '+ line_y +' '+ hx2 +' ' + y +' ' + x +'  ' + y;
          break;
          default:
          
          var hx1 = line_x + Math.abs(x - line_x) * curvature;
          var hx2 = x - Math.abs(x - line_x) * curvature;
          
          return ' M '+ line_x +' '+ line_y +' C '+ hx1 +' '+ line_y +' '+ hx2 +' ' + y +' ' + x +'  ' + y;
        }
      }
    } else {
      // Make lines straight
      this.editor.curvature = 0
      this.editor.reroute_curvature_start_end = 0
      this.editor.reroute_curvature = 0
      this.editor.createCurvature = function(start_pos_x, start_pos_y, end_pos_x, end_pos_y) {
        var center_y = (end_pos_y - start_pos_y) / 2 + start_pos_y;
        return (
          ' M ' +
          start_pos_x +
          ' ' +
          start_pos_y +
          ' L ' +
          start_pos_x +
          ' ' +
          center_y +
          ' L ' +
          end_pos_x +
          ' ' +
          center_y +
          ' L ' +
          end_pos_x +
          ' ' +
          end_pos_y
          )
        }
    }
    this.refreshNodeDisplay();
  }
  
  /**
   * Enable/Disable the reduce mode
   * The reduce mode hide all inputs and outputs
   */
  updateReducedMode() {
    var checked = document.getElementById("reduced-check").checked;
    this.setOption("reduced-mode", checked);
    
    var outputs = document.querySelectorAll(".output");
    var inputs = document.querySelectorAll(".input");
    var cables = document.querySelectorAll(".cable");
    if (checked) {
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i];
        output.style.position = "absolute";
        output.style.right = "40px";
        output.style.left = "";
        output.style.top = "20px";
        output.style.visibility = "hidden";
      }
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        input.style.position = "absolute";
        input.style.left = "53px";
        input.style.right = "";
        input.style.top = "28px";
        input.style.visibility = "hidden";
      }
      for (let i = 0; i < cables.length; i++) {
        cables[i].style.display = "";
      }
    } else {
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i];
        output.style.position = "";
        output.style.right = "";
        output.style.top = "";
        output.style.visibility = "";
      }
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        input.style.position = "";
        input.style.left = "";
        input.style.top = "";
        input.style.visibility = "";
      }
      for (let i = 0; i < cables.length; i++) {
        cables[i].style.display = "none";
      }
    }
    this.refreshNodeDisplay();
  }
}