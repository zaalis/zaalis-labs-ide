'use strict';

// Guest-side network policy for a connected Linux VM, written into cloud-init.
// QEMU user networking maps 10.0.2.2 to the host's loopback: services the user
// runs on 127.0.0.1 would be reachable from the guest. New connections to it
// are rejected; replies to the host's SSH session are still allowed by
// connection tracking. The host checks the policy took effect.

const SLIRP_HOST = '10.0.2.2';

function nftRules() {
  return ['table inet zaalis {', '  chain output {',
    '    type filter hook output priority 0; policy accept;', '    ct state established,related accept',
    `    ip daddr ${SLIRP_HOST} reject with icmpx type admin-prohibited`, '  }', '}'].join('\n') + '\n';
}

// bootcmd runs before the SSH keys are installed and before sshd starts, at
// every boot, so the policy is in place before the host can connect.
function cloudConfig({ id, publicKey, network = 'isolated' }) {
  const lines = ['#cloud-config', 'users:', '  - name: zaalis', '    sudo: ALL=(ALL) NOPASSWD:ALL', '    shell: /bin/bash',
    '    ssh_authorized_keys:', `      - ${publicKey}`, 'ssh_pwauth: false', 'disable_root: true'];
  if (network === 'internet') {
    const rules = Buffer.from(nftRules()).toString('base64');
    const command = `echo ${rules} | base64 -d > /run/zaalis.nft && command -v nft >/dev/null 2>&1 && nft delete table inet zaalis >/dev/null 2>&1; ` +
      `if command -v nft >/dev/null 2>&1 && nft -f /run/zaalis.nft; then echo active > /run/zaalis-firewall; else echo unavailable > /run/zaalis-firewall; fi`;
    lines.push('bootcmd:', `  - [sh, -c, ${JSON.stringify(command)}]`);
  }
  return { meta: `instance-id: ${id}\nlocal-hostname: zaalis-vm\n`, user: lines.join('\n') + '\n' };
}

module.exports = { nftRules, cloudConfig, SLIRP_HOST };
