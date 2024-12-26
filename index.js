const app = require('photoshop').app;
const { entrypoints } = require("uxp");
const { core } = require("photoshop");
const { batchPlay } = require("photoshop").action;

let syncGroups = new Map();
let previousStates = new Map();
let layerCache = new Map(); // 图层名称到图层引用的映射
let lastDocId = null; // 用于检测文档是否改变

entrypoints.setup({
  panels: {
        LayerSync: {
      show() {
                setupUI();
      }
    }
  }
});

function setupUI() {
    const syncButton = document.getElementById('syncButton');
    syncButton.addEventListener('click', handleSyncButtonClick);
    
    // 降低更新频率到 500ms
    setInterval(async () => {
        await updateUI();
    }, 500);
}

// 添加防抖函数
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// 优化 updateUI 函数
const debouncedUpdateUI = debounce(async () => {
    try {
        const doc = app.activeDocument;
        if (!doc) return;
        
        // 只在文档ID改变或缓存为空时更新缓存
        if (lastDocId !== doc.id || layerCache.size === 0) {
            await updateLayerCache();
        }
        
        await Promise.all([
            updateButtonText(),
            updateSyncGroupsList()
        ]);
    } catch (err) {
        console.error('更新UI时出错:', err);
    }
}, 100);

async function updateUI() {
    try {
        await updateButtonText();
        await updateSyncGroupsList();
    } catch (err) {
        console.error('更新UI时出错:', err);
    }
}

async function updateSyncGroupsList() {
    const syncGroupsContainer = document.querySelector('.sync-groups-container');
    const fragment = document.createDocumentFragment();
    
    // 创建同步组的Map
    const uniqueGroups = new Map();
    const processedLayers = new Set();
    
    // 遍历所有同步关系，构建唯一的同步组
    for (const [layerId, syncedLayers] of syncGroups.entries()) {
        // 如果这个图层已经被处理过，跳过
        if (processedLayers.has(layerId)) continue;
        
        // 收集这个同步组的所有图层ID
        const groupLayerIds = new Set([layerId]);
        syncedLayers.forEach(layer => groupLayerIds.add(layer.id));
        
        // 标记这些图层为已处理
        for (const id of groupLayerIds) {
            processedLayers.add(id);
        }
        
        // 使用排序后的图层ID作为key
        const groupKey = Array.from(groupLayerIds).sort().join(',');
        
        // 获取组内所有图层的信息
        const layersInfo = Array.from(groupLayerIds)
            .map(id => {
                const layer = layerCache.get(id);
                if (!layer) return null;
                return {
                    id: layer.id,
                    name: layer.name,
                    // 添加更多可能需要的信息，比如路径等
                    path: getLayerPath(layer)
                };
            })
            .filter(info => info !== null);
            
        uniqueGroups.set(groupKey, layersInfo);
    }
    
    // 创建同步组列表
    let groupIndex = 1;
    for (const [_, layersInfo] of uniqueGroups) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'sync-group';
        
        const headerDiv = document.createElement('div');
        headerDiv.className = 'sync-group-header';
        
        // 添加控制按钮容器
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'sync-group-controls';
        
        // 添加可见性切换按钮
        const visibilityButton = document.createElement('sp-action-button');
        visibilityButton.setAttribute('quiet', '');
        visibilityButton.setAttribute('size', 'xs');
        visibilityButton.style.cursor = 'pointer';
        visibilityButton.title = '切换组内所有图层可见性';
        
        // 检查组内图层的可见性状态
        const layersInGroup = layersInfo
            .map(info => layerCache.get(info.id))
            .filter(layer => layer);
        
        const allVisible = layersInGroup.every(layer => layer.visible);
        
        // 根据可见性状态设置不同的图标
        visibilityButton.innerHTML = allVisible ? `
            <div slot="icon" style="width: 18px; height: 18px;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                    <path fill="currentColor" d="M9 3.5c-3.3 0-6.3 2.1-7.5 5.3 1.2 3.2 4.2 5.3 7.5 5.3s6.3-2.1 7.5-5.3C15.3 5.6 12.3 3.5 9 3.5zm0 8.8c-1.9 0-3.5-1.6-3.5-3.5S7.1 5.3 9 5.3s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
                </svg>
            </div>
        ` : `
            <div slot="icon" style="width: 18px; height: 18px;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                    <path fill="currentColor" d="M13.359 11.238l-.707.707-2.12-2.121A5.228 5.228 0 018 10.5c-2.7 0-5.1-1.7-6-4.2.378-1.037 1.094-1.938 2.018-2.696L2.641 2.227l.707-.707 10.011 10.011zM8 4.5c.5 0 1 .1 1.4.3L7.8 3.2C7.9 3.1 7.9 3.1 8 3.1c2.7 0 5.1 1.7 6 4.2-.4 1-1 1.9-1.8 2.5l-1.2-1.2c.2-.4.3-.9.3-1.4 0-1.7-1.3-3-3-3-.5 0-1 .1-1.4.3L5.5 3.1c.7-.4 1.6-.6 2.5-.6zM4.3 5.2l1.2 1.2c-.2.4-.3.9-.3 1.4 0 1.7 1.3 3 3 3 .5 0 1-.1 1.4-.3l1.2 1.2c-.8.5-1.7.7-2.6.7-2.7 0-5.1-1.7-6-4.2.4-1 1-1.9 1.8-2.5z"/>
                </svg>
            </div>
        `;
        
        // 添加删除按钮
        const deleteButton = document.createElement('sp-action-button');
        deleteButton.setAttribute('quiet', '');
        deleteButton.setAttribute('size', 'xs');
        deleteButton.style.cursor = 'pointer';
        deleteButton.title = '删除同步组';
        deleteButton.innerHTML = `
            <div slot="icon" style="width: 18px; height: 18px;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                    <path fill="currentColor" d="M13.7 4.3l-1-.1V3c0-.6-.4-1-1-1H6.3c-.6 0-1 .4-1 1v1.2l-1 .1c-.5.1-.9.5-.9 1v1.2h11.2V5.3c0-.5-.4-.9-.9-1zM6.8 3.5h4.4v.7H6.8v-.7zm5.4 4.1H5.8v6.8c0 .6.4 1 1 1h4.4c.6 0 1-.4 1-1V7.6z"/>
                </svg>
            </div>
        `;
        
        // 组装界面元素
        controlsDiv.appendChild(visibilityButton);
        controlsDiv.appendChild(deleteButton);
        headerDiv.appendChild(controlsDiv);

        // 添加标题
        const titleDiv = document.createElement('div');
        titleDiv.className = 'sync-group-title';
        titleDiv.textContent = `同步组 ${groupIndex}`;
        
        headerDiv.appendChild(titleDiv);
        
        const layersDiv = document.createElement('div');
        layersDiv.className = 'sync-group-layers';
        
        // 添加图层列表
        layersInfo.forEach(info => {
            const layerDiv = document.createElement('div');
            layerDiv.className = 'sync-layer';
            
            // 添加可见性图标
            const visibilityIcon = document.createElement('span');
            visibilityIcon.className = 'sync-layer-visibility';
            
            // 添加图层名称和路径
            const layerName = document.createElement('span');
            // 如果有同名图层，显示完整路径
            const hasDuplicateName = layersInfo.filter(l => l.name === info.name).length > 1;
            layerName.textContent = hasDuplicateName ? info.path : info.name;
            
            layerDiv.appendChild(visibilityIcon);
            layerDiv.appendChild(layerName);
            layersDiv.appendChild(layerDiv);
        });
        
        groupDiv.appendChild(headerDiv);
        groupDiv.appendChild(layersDiv);
        
        // 点击组的处理
        groupDiv.addEventListener('click', async (event) => {
            const wasSelected = groupDiv.classList.contains('selected');
            
            // 立即更新UI
            if (!event.shiftKey) {
                document.querySelectorAll('.sync-group').forEach(group => {
                    if (group !== groupDiv) {
                        group.classList.remove('selected');
                    }
                });
            }
            
            if (wasSelected) {
                groupDiv.classList.remove('selected');
            } else {
                groupDiv.classList.add('selected');
            }

            // 更新图层缓存
            await updateLayerCache();

            // 使用批处理更新图层选择状态
            try {
                await core.executeAsModal(async () => {
                    // 准备批处理命令
                    const commands = [];
                    
                    if (!event.shiftKey) {
                        // 如果不是Shift点击，先取消所有选择
                        commands.push({
                            _obj: "selectNoLayers"
                        });
                    }
                    
                    // 添加选择命令
                    const targetLayers = layersInfo
                        .map(info => layerCache.get(info.id))
                        .filter(layer => layer); // 过滤掉未找到的图层
                    
                    if (targetLayers.length > 0) {
                        commands.push({
                            _obj: "select",
                            _target: targetLayers.map(layer => ({
                                _ref: "layer",
                                _id: layer.id
                            })),
                            makeVisible: false,
                            layerID: targetLayers.map(layer => layer.id),
                            selectionModifier: event.shiftKey ? "addToSelection" : "removeFromSelection"
                        });
                    }
                    
                    // 执行批处理
                    await require("photoshop").action.batchPlay(commands, {});
                    
                }, { commandName: '选择同步组图层' });
            } catch (err) {
                console.error('选择图层时出错:', err);
            }
        });

        // 添加点击事件处理
        visibilityButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            try {
                await core.executeAsModal(async () => {
                    const targetLayers = layersInfo
                        .map(info => layerCache.get(info.id))
                        .filter(layer => layer);

                    const allVisible = targetLayers.every(layer => layer.visible);
                    
                    // 切换可见性
                    for (const layer of targetLayers) {
                        layer.visible = !allVisible;
                    }
                    
                    // 更新按钮图标
                    visibilityButton.innerHTML = !allVisible ? `
                        <div slot="icon" style="width: 18px; height: 18px;">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                                <path fill="currentColor" d="M9 3.5c-3.3 0-6.3 2.1-7.5 5.3 1.2 3.2 4.2 5.3 7.5 5.3s6.3-2.1 7.5-5.3C15.3 5.6 12.3 3.5 9 3.5zm0 8.8c-1.9 0-3.5-1.6-3.5-3.5S7.1 5.3 9 5.3s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
                            </svg>
                        </div>
                    ` : `
                        <div slot="icon" style="width: 18px; height: 18px;">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                                <path fill="currentColor" d="M13.359 11.238l-.707.707-2.12-2.121A5.228 5.228 0 018 10.5c-2.7 0-5.1-1.7-6-4.2.378-1.037 1.094-1.938 2.018-2.696L2.641 2.227l.707-.707 10.011 10.011zM8 4.5c.5 0 1 .1 1.4.3L7.8 3.2C7.9 3.1 7.9 3.1 8 3.1c2.7 0 5.1 1.7 6 4.2-.4 1-1 1.9-1.8 2.5l-1.2-1.2c.2-.4.3-.9.3-1.4 0-1.7-1.3-3-3-3-.5 0-1 .1-1.4.3L5.5 3.1c.7-.4 1.6-.6 2.5-.6zM4.3 5.2l1.2 1.2c-.2.4-.3.9-.3 1.4 0 1.7 1.3 3 3 3 .5 0 1-.1 1.4-.3l1.2 1.2c-.8.5-1.7.7-2.6.7-2.7 0-5.1-1.7-6-4.2.4-1 1-1.9 1.8-2.5z"/>
                            </svg>
                        </div>
                    `;
                }, { commandName: '切换同步组可见性' });
            } catch (err) {
                console.error('切换图层可见性时出错:', err);
            }
        });

        deleteButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            try {
                // 获取当前组内所有图层的ID
                const currentGroupLayerIds = new Set(layersInfo.map(info => info.id));
                
                // 收集所有需要删除的同步关系
                const relatedIds = new Set();
                const queue = Array.from(currentGroupLayerIds);
                
                while (queue.length > 0) {
                    const currentId = queue.pop();
                    if (relatedIds.has(currentId)) continue;
                    
                    relatedIds.add(currentId);
                    const syncedLayers = syncGroups.get(currentId);
                    if (syncedLayers) {
                        syncedLayers.forEach(layer => {
                            if (!relatedIds.has(layer.id)) {
                                queue.push(layer.id);
                            }
                        });
                    }
                }

                // 删除所有相关的同步关系
                for (const id of relatedIds) {
                    if (syncGroups.has(id)) {
                        const layer = layerCache.get(id);
                        syncGroups.delete(id);
                        previousStates.delete(id);
                    }
                }

                // 移除组元素
                groupDiv.remove();
                
                // 更新UI以反映变化
                await updateUI();
            } catch (err) {
                console.error('删除同步组时出错:', err);
            }
        });

        fragment.appendChild(groupDiv);
        groupIndex++;
    }
    
    // 清空容器并一次性添加所有元素
    syncGroupsContainer.innerHTML = '';
    syncGroupsContainer.appendChild(fragment);
}

async function updateButtonText() {
    try {
        const syncButton = document.getElementById('syncButton');
        const selectedLayers = await getSelectedLayers();
        
        if (selectedLayers.length < 2) {
            syncButton.textContent = '同步显示图层';
            return;
        }
        
        // 检查选中的图层是否已经在同步组中，并且是否完全匹配
        let hasSyncedLayers = false;
        
        // 检查任意选中图层是否在同步组中
        for (const layer of selectedLayers) {
            if (syncGroups.has(layer.id)) {
                const syncedLayers = syncGroups.get(layer.id);
                const selectedIds = new Set(selectedLayers.map(l => l.id));
                selectedIds.delete(layer.id); // 移除当前图层ID
                
                // 检查同步组中的图层是否与当前选中的图层完全匹配
                const syncedIds = new Set(syncedLayers.map(l => l.id));
                
                // 如果两个集合完全相同，说明找到了完全匹配的同步组
                if (setsAreEqual(selectedIds, syncedIds)) {
                    hasSyncedLayers = true;
                    break;
                }
            }
        }
        
        // 更新按钮文本
        syncButton.textContent = hasSyncedLayers ? '取消同步显示图层' : '同步显示图层';
        
    } catch (err) {
        console.error('更新按钮文本时出错:', err);
    }
}

// 辅助函数：检查两个 Set 是否完全相同
function setsAreEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const item of a) {
        if (!b.has(item)) return false;
    }
    return true;
}

async function handleSyncButtonClick() {
    try {
        const doc = app.activeDocument;
        const selectedLayers = await getSelectedLayers();

        if (selectedLayers.length < 2) {
            await app.showAlert('请至少选择两个图层进行同步显示');
            return;
        }

        // 更新图层缓存
        await updateLayerCache();

        // 检查是否应该取消同步
        let shouldRemoveSync = false;
        for (const layer of selectedLayers) {
            if (syncGroups.has(layer.id)) {
                const syncedLayers = syncGroups.get(layer.id);
                const selectedIds = new Set(selectedLayers.map(l => l.id));
                selectedIds.delete(layer.id);
                
                const syncedIds = new Set(syncedLayers.map(l => l.id));
                if (setsAreEqual(selectedIds, syncedIds)) {
                    shouldRemoveSync = true;
                    break;
                }
            }
        }

        if (shouldRemoveSync) {
            // 收集需要删除的同步关系
            const relatedIds = new Set();
            for (const layer of selectedLayers) {
                if (syncGroups.has(layer.id)) {
                    relatedIds.add(layer.id);
                    const syncedLayers = syncGroups.get(layer.id);
                    syncedLayers.forEach(sl => relatedIds.add(sl.id));
                }
            }

            // 删除所有相关的同步关系
            for (const id of relatedIds) {
                if (syncGroups.has(id)) {
                    const layer = layerCache.get(id);
                    syncGroups.delete(id);
                    previousStates.delete(id);
                }
            }
        } else {
            // 创建新的同步组
            const selectedIds = new Set(selectedLayers.map(l => l.id));
            
            // 确保所有选中的图层都建立双向关系
            for (const layer of selectedLayers) {
                const otherLayers = selectedLayers
                    .filter(l => l.id !== layer.id)
                    .map(l => layerCache.get(l.id))
                    .filter(l => l);

                syncGroups.set(layer.id, otherLayers);
                previousStates.set(layer.id, layer.visible);
            }
        }

        // 开始监听图层变化
        startWatching();
        
        // 更新UI
        await updateUI();

    } catch (err) {
        console.error('同步图层时出错:', err);
    }
}

async function getSelectedLayers() {
    const doc = app.activeDocument;
    const allLayers = await getAllLayers(doc);
    return allLayers.filter(layer => layer.selected);
}

let watcherInterval = null;

function startWatching() {
    if (watcherInterval) return;
    
    const debouncedCheck = debounce(checkLayerChanges, 100);
    watcherInterval = setInterval(debouncedCheck, 100);
}

async function checkLayerChanges() {
    try {
        const doc = app.activeDocument;
        if (!doc) return;
        
        // 批量收集需要更新的图层
        const updates = [];
        const processed = new Set();
        
        for (const [layerId, syncedLayers] of syncGroups.entries()) {
            if (processed.has(layerId)) continue;
            
            const layer = layerCache.get(layerId);
            if (!layer) continue;
            
            const previousState = previousStates.get(layerId);
            const currentState = layer.visible;
            
            if (previousState !== undefined && previousState !== currentState) {
                updates.push({ layer, syncedLayers, newState: currentState });
                processed.add(layerId);
                
                // 标记同步组内的所有图层为处理
                for (const syncedLayer of syncedLayers) {
                    processed.add(syncedLayer.id);
                }
            }
        }
        
        // 如果有需要更新的图层，一次性执行所有更新
        if (updates.length > 0) {
            await core.executeAsModal(async () => {
                for (const { layer, syncedLayers, newState } of updates) {
                    for (const targetLayer of syncedLayers) {
                        if (targetLayer.visible !== newState) {
                            targetLayer.visible = newState;
                            previousStates.set(targetLayer.id, newState);
                        }
                    }
                    previousStates.set(layer.id, newState);
                }
            }, { commandName: '批量同步图层可见性' });
        }
    } catch (err) {
        console.error('检查图层变化时出错:', err);
    }
}

async function syncLayerVisibility(sourceLayer, targetLayers) {
    try {
        await core.executeAsModal(async () => {
            for (const targetLayer of targetLayers) {
                if (targetLayer.visible !== sourceLayer.visible) {
                    targetLayer.visible = sourceLayer.visible;
                    // 更新目标图层的状态记录
                    previousStates.set(targetLayer.id, sourceLayer.visible);
                }
            }
        }, { commandName: '同步图层可见性' });
    } catch (err) {
        console.error('同步图层可见性时出错:', err);
    }
}

async function getAllLayers(parent) {
    try {
        const layers = [];
        for (const layer of parent.layers) {
            layers.push(layer);
            if (layer.layers && layer.layers.length > 0) {
                layers.push(...await getAllLayers(layer));
            }
        }
        return layers;
    } catch (err) {
        console.error('获取图层时出错:', err);
        return [];
  }
}

// 更新图层缓存
async function updateLayerCache() {
    try {
        const doc = app.activeDocument;
        if (!doc) return;
        
        // 如果文档未改变且缓存存在，直接返回
        if (lastDocId === doc.id && layerCache.size > 0) return;
        
        lastDocId = doc.id;
        
        // 使用 Map 预先存储所有图层，避免重复查找
        const newCache = new Map();
        const allLayers = await getAllLayers(doc);
        
        // 批量更新缓存
        allLayers.forEach(layer => {
            newCache.set(layer.id, layer);
        });
        
        // 一次性替换整个缓存
        layerCache = newCache;
    } catch (err) {
        console.error('更新图层缓存时出错:', err);
    }
}

// 添加获取图层路径的辅助函数
function getLayerPath(layer) {
    const path = [];
    let current = layer;
    
    while (current) {
        path.unshift(current.name);
        current = current.parent;
        // 如果到达文档层级，停止
        if (!current || current.typename === "Document") break;
    }
    
    return path.join(" / ");
} 