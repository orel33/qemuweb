// Web UI entry point. Modules only declare things when they are evaluated;
// this file runs their initialization in the order of the former inline script.
import {initAccount} from './account.js';
import {initTerminals} from './terminal.js';
import {initWorkspace} from './workspace.js';
import {initNodes} from './nodes.js';
import {initNodeDialogs} from './node-dialogs.js';
import {initHostSettings} from './host-settings.js';
import {initStartupMedia} from './startup-media.js';
import {initGeneralSettings} from './general-settings.js';
import {initTopology} from './topology.js';
import {initArchive} from './archive.js';
import {initSockets} from './socket.js';
import {initObserve} from './observe.js';

initAccount();
initTerminals();
initStartupMedia();
initGeneralSettings();
initTopology();
initWorkspace();
initNodes();
initArchive();
initNodeDialogs();
initHostSettings();
initSockets();
initObserve();
