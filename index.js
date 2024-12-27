const app = require('photoshop').app;
const { entrypoints } = require("uxp");
const { core } = require("photoshop");
const { batchPlay } = require("photoshop").action;

let syncGroups = new Map();
let previousStates = new Map();
let layerCache = new Map();
let lastDocId = null;
let lastLayerCount = 0;

// 添加图层变化监听
let lastLayerStructure = '';

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
    
    // 降低更新频率，使用 requestAnimationFrame 优化性能
    let updateScheduled = false;
    
    setInterval(() => {
        if (!updateScheduled) {
            updateScheduled = true;
            requestAnimationFrame(async () => {
                await debouncedUpdateUI();
                updateScheduled = false;
            });
        }
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
        
        await updateLayerCache();
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
    
    // 使用 DocumentFragment 优化 DOM 操作
    const fragment = document.createDocumentFragment();
    
    // 创建同步组的Map，使用Set优化查找
    const uniqueGroups = new Map();
    const processedLayers = new Set();
    
    // 批量处理同步关系
    for (const [layerId, syncedLayers] of syncGroups.entries()) {
        if (processedLayers.has(layerId)) continue;
        
        const groupLayerIds = new Set([layerId]);
        syncedLayers.forEach(layer => groupLayerIds.add(layer.id));
        
        for (const id of groupLayerIds) {
            processedLayers.add(id);
        }
        
        const groupKey = Array.from(groupLayerIds).sort().join(',');
        uniqueGroups.set(groupKey, Array.from(groupLayerIds));
    }
    
    // 一次性清空容器
    syncGroupsContainer.innerHTML = '';
    
    // 创建并添加同步组元素
    let groupIndex = 1;
    for (const [_, layerIds] of uniqueGroups) {
        const groupDiv = createSyncGroupElement(layerIds, groupIndex++);
        fragment.appendChild(groupDiv);
    }
    
    // 一次性添加所有元素
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
    
    // 使用适中的检查间隔（30ms）
    watcherInterval = setInterval(checkLayerChanges, 30);
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
                // 收集需要更新的图层
                updates.push({ layer, syncedLayers, newState: currentState });
                processed.add(layerId);
                
                for (const syncedLayer of syncedLayers) {
                    processed.add(syncedLayer.id);
                }
            }
        }
        
        // 如果有更新，一次性批量处理
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
            }, { commandName: '同步图层可见性' });
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
        
        // 获取当���图层结构的快照
        const currentStructure = await getLayerStructureSnapshot(doc);
        
        // 如果图层结构没有变化且缓存存在，直接返回
        if (currentStructure === lastLayerStructure && layerCache.size > 0) {
            return;
        }
        
        // 更新图层结构快照
        lastLayerStructure = currentStructure;
        
        // 使用迭代器更新缓存
        const newCache = new Map();
        const stack = [...doc.layers];
        
        while (stack.length > 0) {
            const layer = stack.pop();
            newCache.set(layer.id, layer);
            
            if (layer.layers && layer.layers.length > 0) {
                stack.push(...layer.layers);
            }
        }
        
        // 检查同步关系中的图层是否仍然存在
        for (const [layerId, syncedLayers] of syncGroups.entries()) {
            if (!newCache.has(layerId)) {
                // 图层已被删除，清理同步关系
                syncGroups.delete(layerId);
                previousStates.delete(layerId);
                continue;
            }
            
            // 过滤掉不存在的同步图层
            const validSyncedLayers = syncedLayers.filter(layer => 
                newCache.has(layer.id)
            );
            
            if (validSyncedLayers.length !== syncedLayers.length) {
                if (validSyncedLayers.length < 2) {
                    // 如果同步组中的图层少于2个，删除整个同步关系
                    syncGroups.delete(layerId);
                    previousStates.delete(layerId);
                } else {
                    // 更新同步关系
                    syncGroups.set(layerId, validSyncedLayers);
                }
            }
        }
        
        layerCache = newCache;
    } catch (err) {
        console.error('更新图层缓存时出错:', err);
    }
}

// 获取图层结构快照
async function getLayerStructureSnapshot(doc) {
    const layerInfo = [];
    const stack = [...doc.layers];
    
    while (stack.length > 0) {
        const layer = stack.pop();
        layerInfo.push(layer.id);
        
        if (layer.layers && layer.layers.length > 0) {
            stack.push(...layer.layers);
        }
    }
    
    return layerInfo.sort().join(',');
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

// 添加创建同步组元素的函数
function createSyncGroupElement(layerIds, groupIndex) {
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
    const layersInGroup = layerIds
        .map(id => layerCache.get(id))
        .filter(layer => layer);
    
    const allVisible = layersInGroup.every(layer => layer.visible);
    
    // 设置可见性按钮图标
    visibilityButton.innerHTML = `
        <div slot="icon" style="width: 18px; height: 18px;">
            ${allVisible ? `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                    <path fill="currentColor" d="M9 3.5c-3.3 0-6.3 2.1-7.5 5.3 1.2 3.2 4.2 5.3 7.5 5.3s6.3-2.1 7.5-5.3C15.3 5.6 12.3 3.5 9 3.5zm0 8.8c-1.9 0-3.5-1.6-3.5-3.5S7.1 5.3 9 5.3s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
                </svg>
            ` : `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                    <path fill="currentColor" d="M9 3.5c-3.3 0-6.3 2.1-7.5 5.3 1.2 3.2 4.2 5.3 7.5 5.3s6.3-2.1 7.5-5.3C15.3 5.6 12.3 3.5 9 3.5zm0 8.8c-1.9 0-3.5-1.6-3.5-3.5S7.1 5.3 9 5.3s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
                    <line x1="4" y1="4" x2="14" y2="14" stroke="#323232" stroke-width="3" stroke-linecap="round"/>
                    <line x1="4" y1="4" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
            `}
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
    
    // 添加标题
    const titleDiv = document.createElement('div');
    titleDiv.className = 'sync-group-title';
    titleDiv.textContent = `同步组 ${groupIndex}`;
    
    // 添加图层列表容器
    const layersDiv = document.createElement('div');
    layersDiv.className = 'sync-group-layers';
    
    // 添加图层列表
    layersInGroup.forEach(layer => {
        const layerDiv = document.createElement('div');
        layerDiv.className = 'sync-layer';
        layerDiv.textContent = layer.name;
        layersDiv.appendChild(layerDiv);
    });
    
    // 添加事件监听器
    visibilityButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        
        // 禁用按钮，防止重复点击
        visibilityButton.disabled = true;
        
        try {
            const targetLayers = layerIds
                .map(id => layerCache.get(id))
                .filter(layer => layer);
            
            const allVisible = targetLayers.every(layer => layer.visible);
            const newState = !allVisible;

            // 使用批处理更新���层可见性
            await core.executeAsModal(async () => {
                const batchCommands = targetLayers.map(layer => ({
                    _obj: "set",
                    _target: [{ _ref: "layer", _id: layer.id }],
                    visible: newState
                }));

                await require("photoshop").action.batchPlay(batchCommands, {});

                // 更新图层缓存中的可见性状态
                targetLayers.forEach(layer => {
                    layer.visible = newState;
                    previousStates.set(layer.id, newState);
                });
            }, { commandName: '切换同步组可见性' });

            // 更新按钮图标
            visibilityButton.innerHTML = `
                <div slot="icon" style="width: 18px; height: 18px;">
                    ${newState ? `
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                            <path fill="currentColor" d="M9 3.5c-3.3 0-6.3 2.1-7.5 5.3 1.2 3.2 4.2 5.3 7.5 5.3s6.3-2.1 7.5-5.3C15.3 5.6 12.3 3.5 9 3.5zm0 8.8c-1.9 0-3.5-1.6-3.5-3.5S7.1 5.3 9 5.3s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
                        </svg>
                    ` : `
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
                            <path fill="currentColor" d="M9 3.5c-3.3 0-6.3 2.1-7.5 5.3 1.2 3.2 4.2 5.3 7.5 5.3s6.3-2.1 7.5-5.3C15.3 5.6 12.3 3.5 9 3.5zm0 8.8c-1.9 0-3.5-1.6-3.5-3.5S7.1 5.3 9 5.3s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
                            <line x1="4" y1="4" x2="14" y2="14" stroke="#323232" stroke-width="3" stroke-linecap="round"/>
                            <line x1="4" y1="4" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                    `}
                </div>
            `;

        } catch (err) {
            console.error('切换图层可见性时出错:', err);
        } finally {
            // 重新启用按钮
            visibilityButton.disabled = false;
        }
    });
    
    deleteButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        
        // 禁用按钮，防止重复点击
        deleteButton.disabled = true;
        
        try {
            // 收集所有需要删除的同步关系
            const relatedIds = new Set();
            const queue = [...layerIds];
            
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

            // 批量删除同步关系
            for (const id of relatedIds) {
                syncGroups.delete(id);
                previousStates.delete(id);
            }

            // 移除组元素并更新UI
            groupDiv.remove();
            await updateUI();
            
        } catch (err) {
            console.error('删除同步组时出错:', err);
        } finally {
            // 重新启用按钮
            deleteButton.disabled = false;
        }
    });
    
    // 组装界面元素
    controlsDiv.appendChild(visibilityButton);
    controlsDiv.appendChild(deleteButton);
    headerDiv.appendChild(controlsDiv);
    headerDiv.appendChild(titleDiv);
    groupDiv.appendChild(headerDiv);
    groupDiv.appendChild(layersDiv);
    
    return groupDiv;
} 