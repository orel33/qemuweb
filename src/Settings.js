/* eslint-disable */
import { getCurrentInstance } from 'vue';

export class Settings {
    constructor() {
        this.container = document.getElementById("settings");
        this.editor = getCurrentInstance().appContext.app._context.config.globalProperties.$df;
    }

    setOption(name, value) {
        this.container.setAttribute("data-" + name, value);
    }

    getOption(name) {
        return this.container.getAttribute("data-" + name);
    }

    changeDisplayInterfacesName() {
        var checked = document.getElementById("interfaces-name-check").checked;
        var display = checked ? "block" : "none";
        this.setOption("display-interfaces-name", checked);
        var interfaces = document.querySelectorAll(".drawflow-node.Host .outputs .output");
        for (const el of interfaces) {
            el.style.setProperty('--vardisplay', display);
        }
    }

    changeDisplayPortsName() {
        var checked = document.getElementById("ports-name-check").checked;
        var display = checked ? "block" : "none";
        this.setOption("display-ports-name", checked);
        var ports = document.querySelectorAll(".drawflow-node.Switch .inputs .input");
        for (const el of ports) {
            el.style.setProperty('--vardisplay', display);
        }
    }

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
        var allNodes = this.editor.getNodesFromName('Host').concat(this.editor.getNodesFromName('Switch'));
        for (const id in allNodes) {
            this.editor.updateConnectionNodes("node-" + id);
        }
    }
}