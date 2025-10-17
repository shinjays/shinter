class UbiquitiToRuckusConverter {
    constructor() {
        this.config = null;
    }

    // Parse Ubiquiti JSON config
    parseUbiquitiConfig(jsonData) {
        try {
            this.config = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
            console.log('JSON parsed successfully:', this.config);
            return true;
        } catch (e) {
            console.error('Error parsing JSON:', e);
            throw new Error('Invalid JSON format: ' + e.message);
        }
    }

    // Extract VLAN information
    extractVlans() {
        const vlans = [];
        const expectedSystemCfg = this.config.expected_system_cfg || [];
        
        console.log('Extracting VLANs from config...');
        
        // Find VLAN configurations
        expectedSystemCfg.forEach(line => {
            // Match VLAN definitions like "switch.vlan.1.id=1"
            if (line.startsWith('switch.vlan.') && line.includes('.id=')) {
                const parts = line.split('=');
                const vlanMatch = line.match(/switch\.vlan\.(\d+)\.id=(\d+)/);
                
                if (vlanMatch && vlanMatch.length >= 3) {
                    const vlanIndex = vlanMatch[1];
                    const vlanId = vlanMatch[2];
                    
                    // Get VLAN name if available
                    let vlanName = `VLAN-${vlanId}`;
                    const nameLine = expectedSystemCfg.find(l => 
                        l === `switch.vlan.${vlanIndex}.name=`
                    );
                    if (nameLine) {
                        const nameParts = nameLine.split('=');
                        if (nameParts.length > 1 && nameParts[1]) {
                            vlanName = nameParts[1];
                        }
                    }
                    
                    // Check if VLAN is enabled
                    const statusLine = expectedSystemCfg.find(l => 
                        l === `switch.vlan.${vlanIndex}.status=`
                    );
                    const isEnabled = !statusLine || statusLine.includes('enabled');
                    
                    if (isEnabled) {
                        vlans.push({
                            id: vlanId,
                            name: vlanName,
                            index: vlanIndex
                        });
                    }
                }
            }
        });
        
        console.log(`Found ${vlans.length} VLANs:`, vlans);
        return vlans;
    }

    // Extract port configurations
    extractPortConfigs() {
        const ports = [];
        const expectedSystemCfg = this.config.expected_system_cfg || [];
        
        console.log('Extracting port configurations...');
        
        // Find port configurations
        for (let i = 1; i <= 52; i++) {
            const portConfig = {
                number: i,
                name: `Port-${i}`,
                status: 'enabled',
                pvid: '1',
                taggedVlans: [],
                untaggedVlan: null
            };
            
            // Get port name
            const nameLine = expectedSystemCfg.find(line => 
                line.startsWith(`switch.port.${i}.name=`)
            );
            if (nameLine) {
                const nameParts = nameLine.split('=');
                if (nameParts.length > 1 && nameParts[1]) {
                    portConfig.name = nameParts[1];
                }
            }
            
            // Get port status
            const statusLine = expectedSystemCfg.find(line => 
                line.startsWith(`switch.port.${i}.status=`)
            );
            if (statusLine && statusLine.includes('disabled')) {
                portConfig.status = 'disabled';
            }
            
            // Get PVID
            const pvidLine = expectedSystemCfg.find(line => 
                line.startsWith(`switch.port.${i}.pvid=`)
            );
            if (pvidLine) {
                const pvidParts = pvidLine.split('=');
                if (pvidParts.length > 1 && pvidParts[1]) {
                    portConfig.pvid = pvidParts[1];
                    portConfig.untaggedVlan = pvidParts[1]; // PVID is usually the untagged VLAN
                }
            }
            
            ports.push(portConfig);
        }
        
        // Second pass: get VLAN assignments
        const vlans = this.extractVlans();
        vlans.forEach(vlan => {
            for (let i = 1; i <= 52; i++) {
                const vlanPortMode = expectedSystemCfg.find(line => 
                    line === `switch.vlan.${vlan.index}.port.${i}.mode=`
                );
                if (vlanPortMode) {
                    const modeParts = vlanPortMode.split('=');
                    if (modeParts.length > 1) {
                        const mode = modeParts[1];
                        const port = ports.find(p => p.number === i);
                        if (port && port.status !== 'disabled') {
                            if (mode === 'untagged') {
                                port.untaggedVlan = vlan.id;
                            } else if (mode === 'tagged') {
                                if (!port.taggedVlans.includes(vlan.id)) {
                                    port.taggedVlans.push(vlan.id);
                                }
                            }
                        }
                    }
                }
            }
        });
        
        console.log('Port configurations:', ports);
        return ports;
    }

    // Generate Ruckus configuration
    generateRuckusConfig() {
        const vlans = this.extractVlans();
        const ports = this.extractPortConfigs();
        
        let config = "!\nstack unit 1\n  module 1 icx7650-48p-poe-module\n  module 2 icx7650-8x10g-module\n!\nglobal-stp\n!\n";
        
        // Generate VLAN configurations
        config += "vlan 1 name DEFAULT-VLAN by port\n!\n";
        
        vlans.forEach(vlan => {
            if (vlan.id !== '1') {
                config += `vlan ${vlan.id} name ${vlan.name.replace(/ /g, '-')} by port\n`;
                
                // Find ports with this VLAN as untagged
                const untaggedPorts = ports.filter(p => p.untaggedVlan === vlan.id && p.status !== 'disabled');
                if (untaggedPorts.length > 0) {
                    const portList = untaggedPorts.map(p => p.number).join(' ethe 1/1/');
                    config += ` untagged ethe 1/1/${portList}\n`;
                }
                
                // Find ports with this VLAN as tagged
                const taggedPorts = ports.filter(p => p.taggedVlans.includes(vlan.id) && p.status !== 'disabled');
                if (taggedPorts.length > 0) {
                    const portList = taggedPorts.map(p => p.number).join(' ethe 1/1/');
                    config += ` tagged ethe 1/1/${portList}\n`;
                }
                
                // Add router interface for management VLAN
                if (vlan.id === '1103') {
                    config += ` router-interface ve ${vlan.id}\n`;
                }
                
                config += "!\n";
            }
        });
        
        // Generate port configurations
        config += "! Port Configuration\n";
        ports.forEach(port => {
            config += `interface ethernet 1/1/${port.number}\n`;
            config += ` port-name "${port.name}"\n`;
            if (port.status === 'disabled') {
                config += ` disable\n`;
            }
            config += "!\n";
        });
        
        // Generate management interface
        const mgmtVlan = vlans.find(v => v.id === '1103');
        if (mgmtVlan) {
            config += `! Management Interface\n`;
            config += `interface ve 1103\n`;
            config += ` ip address 10.255.103.25 255.255.255.0\n`;
            config += ` ip gateway 10.255.103.1\n`;
            config += "!\n";
        } else {
            // Fallback management interface
            config += `! Management Interface\n`;
            config += `interface ve 1\n`;
            config += ` ip address 192.168.1.100 255.255.255.0\n`;
            config += "!\n";
        }
        
        // System configuration
        config += `! System Configuration\n`;
        config += `hostname SWITCHIGDLT2\n`;
        config += `clock timezone "WIB-7" 7\n`;
        config += `snmp-server community public ro\n`;
        config += `ntp-server 172.16.0.2\n`;
        config += "!\n";
        
        // User accounts
        config += `! User Accounts\n`;
        config += `username itikom password .....\n`;
        config += `username admin password .....\n`;
        config += "!\n";
        
        // PoE configuration
        config += `! PoE Configuration\n`;
        config += `power-over-ethernet enable\n`;
        config += "!\n";
        
        config += "end\n";
        
        return config;
    }

    // Main conversion function
    convert(jsonData) {
        if (!this.parseUbiquitiConfig(jsonData)) {
            throw new Error('Invalid JSON configuration file');
        }
        
        return this.generateRuckusConfig();
    }
}

// Global functions for the web interface
function convertConfig() {
    const fileInput = document.getElementById('fileInput');
    const resultTextarea = document.getElementById('result');
    const fileInfo = document.getElementById('fileInfo');
    
    if (!fileInput.files.length) {
        alert('Please select a JSON file first');
        return;
    }
    
    const file = fileInput.files[0];
    fileInfo.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`;
    
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            console.log('Starting conversion...');
            const converter = new UbiquitiToRuckusConverter();
            const ruckusConfig = converter.convert(e.target.result);
            resultTextarea.value = ruckusConfig;
            console.log('Conversion completed successfully');
        } catch (error) {
            alert('Error converting configuration: ' + error.message);
            console.error('Conversion error:', error);
        }
    };
    
    reader.onerror = function() {
        alert('Error reading file');
    };
    
    reader.readAsText(file);
}

function downloadConfig() {
    const resultTextarea = document.getElementById('result');
    const config = resultTextarea.value;
    
    if (!config || config.trim() === '') {
        alert('No configuration to download. Please convert first.');
        return;
    }
    
    const blob = new Blob([config], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ruckus_config.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function copyToClipboard() {
    const resultTextarea = document.getElementById('result');
    
    if (!resultTextarea.value || resultTextarea.value.trim() === '') {
        alert('No configuration to copy. Please convert first.');
        return;
    }
    
    resultTextarea.select();
    resultTextarea.setSelectionRange(0, 99999); // For mobile devices
    
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            alert('Configuration copied to clipboard!');
        } else {
            alert('Failed to copy configuration. Please try again.');
        }
    } catch (err) {
        alert('Error copying to clipboard: ' + err);
    }
}

function clearAll() {
    document.getElementById('fileInput').value = '';
    document.getElementById('fileInfo').textContent = 'No file selected';
    document.getElementById('result').value = '';
}

// Add event listener for file input change
document.getElementById('fileInput').addEventListener('change', function(e) {
    const fileInfo = document.getElementById('fileInfo');
    if (this.files.length > 0) {
        const file = this.files[0];
        fileInfo.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`;
    } else {
        fileInfo.textContent = 'No file selected';
    }
});