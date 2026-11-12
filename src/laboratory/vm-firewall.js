'use strict';

// Guest-side network policy, written into cloud-init (QEMU) or applied as root
// before any agent command (containers).
//
// * A connected Linux VM uses QEMU user networking, where 10.0.2.2 is the
//   host's loopback: services the user runs on 127.0.0.1 would be reachable.
//   New connections to it are rejected (replies to the host's SSH session are
//   still allowed by connection tracking).
// * A pentest machine drops every outbound packet except DNS and the networks
//   resolved from the confirmed scope. Its agent account has no sudo and no
//   CAP_NET_ADMIN, so it cannot lift the policy; the host verifies both before
//   the machine is reported ready.

const SLIRP_HOST = '10.0.2.2';
const SLIRP_DNS = '10.0.2.3';

// Debian 12 packages installed in the pentest template. A package missing from
// the mirror is reported, not fatal.
const PENTEST_PACKAGES = ['nftables', 'libcap2-bin', 'nmap', 'masscan', 'sqlmap', 'nikto', 'whatweb', 'dirb', 'gobuster', 'ffuf',
  'wfuzz', 'hydra', 'john', 'sslscan', 'testssl.sh', 'dnsutils', 'whois', 'curl', 'wget', 'netcat-openbsd', 'ncat', 'socat',
  'smbclient', 'ldap-utils', 'snmp', 'onesixtyone', 'python3-impacket', 'python3-requests', 'jq', 'git', 'tcpdump', 'wordlists', 'seclists'];

function ports(list) { return `{ ${list.join(', ')} }`; }

function nftRules({ profile = 'connected', networks = [], hostPorts = [], hostAll = false, excluded = [] } = {}) {
  const lines = ['table inet zaalis {', '  chain output {'];
  if (profile === 'pentest') {
    lines.push('    type filter hook output priority 0; policy drop;', '    ct state established,related accept', '    oif "lo" accept',
      `    ip daddr ${SLIRP_DNS} udp dport 53 accept`, `    ip daddr ${SLIRP_DNS} tcp dport 53 accept`);
    // Exclusions come before the allowed networks that contain them.
    for (const cidr of excluded) lines.push(`    ip daddr ${cidr} reject with icmpx type admin-prohibited`);
    for (const { cidr, port } of networks) {
      if (port) lines.push(`    ip daddr ${cidr} tcp dport ${port} accept`, `    ip daddr ${cidr} udp dport ${port} accept`, `    ip daddr ${cidr} icmp type echo-request accept`);
      else lines.push(`    ip daddr ${cidr} accept`);
    }
    if (hostAll) lines.push(`    ip daddr ${SLIRP_HOST} accept`);
    else if (hostPorts.length) lines.push(`    ip daddr ${SLIRP_HOST} tcp dport ${ports(hostPorts)} accept`);
    lines.push('    counter reject with icmpx type admin-prohibited');
  } else {
    lines.push('    type filter hook output priority 0; policy accept;', '    ct state established,related accept', `    ip daddr ${SLIRP_HOST} reject with icmpx type admin-prohibited`);
  }
  lines.push('  }', '}');
  return lines.join('\n') + '\n';
}

// cloud-init user data. bootcmd runs before the SSH keys are installed and
// before sshd starts, at every boot, so the policy is in place before the host
// can connect.
function cloudConfig({ id, publicKey, network = 'isolated', profile = null, egress = null }) {
  const pentest = profile === 'pentest';
  const lines = ['#cloud-config', 'users:', '  - name: zaalis'];
  if (!pentest) lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL');
  lines.push('    shell: /bin/bash', '    ssh_authorized_keys:', `      - ${publicKey}`, 'ssh_pwauth: false', 'disable_root: true');
  const boot = [];
  if (pentest) {
    // A template image keeps the sudoers entry written when it was built.
    boot.push('rm -f /etc/sudoers.d/90-cloud-init-users; gpasswd -d zaalis sudo >/dev/null 2>&1 || true');
    boot.push('grep -q NMAP_PRIVILEGED /etc/environment || echo NMAP_PRIVILEGED=1 >> /etc/environment');
  }
  if (network === 'internet' || pentest) {
    const rules = Buffer.from(nftRules({ profile: pentest ? 'pentest' : 'connected', ...(egress || {}) })).toString('base64');
    boot.push(`echo ${rules} | base64 -d > /run/zaalis.nft && command -v nft >/dev/null 2>&1 && nft delete table inet zaalis >/dev/null 2>&1; ` +
      `if command -v nft >/dev/null 2>&1 && nft -f /run/zaalis.nft; then echo active > /run/zaalis-firewall; else echo unavailable > /run/zaalis-firewall; fi`);
  }
  if (boot.length) {
    lines.push('bootcmd:');
    for (const command of boot) lines.push(`  - [sh, -c, ${JSON.stringify(command)}]`);
  }
  return { meta: `instance-id: ${id}\nlocal-hostname: zaalis-vm\n`, user: lines.join('\n') + '\n' };
}

// Shell run once with root rights in the template-building VM.
function pentestInstallScript() {
  return [
    'set -u', 'export DEBIAN_FRONTEND=noninteractive',
    'sudo apt-get update -q >/tmp/zaalis-install.log 2>&1 || { echo APT_UPDATE_FAILED; exit 1; }',
    `for p in ${PENTEST_PACKAGES.join(' ')}; do if sudo apt-get install -y -q --no-install-recommends "$p" >>/tmp/zaalis-install.log 2>&1; then echo "OK $p"; else echo "ABSENT $p"; fi; done`,
    // Raw sockets for scanners without root; never CAP_NET_ADMIN.
    'for b in /usr/lib/nmap/nmap /usr/bin/nmap /usr/bin/masscan /usr/sbin/tcpdump; do [ -f "$b" ] && sudo setcap cap_net_raw,cap_net_bind_service+eip "$b" && echo "CAP $b"; done',
    'command -v nft >/dev/null 2>&1 || sudo test -x /usr/sbin/nft || { echo NFT_MISSING; exit 2; }',
    'echo INSTALL_DONE',
  ].join('\n');
}

// iptables policy for a pentest container, applied as root before any agent
// command; agent commands then run as the unprivileged `pentest` user.
function containerFirewall({ networks = [], hostPorts = [], hostAll = false, hostAddress = null, excluded = [] } = {}) {
  const rules = ['set -e', 'iptables -F OUTPUT', 'iptables -P OUTPUT DROP', 'iptables -A OUTPUT -o lo -j ACCEPT',
    'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    ...excluded.map(cidr => `iptables -A OUTPUT -d ${cidr} -j REJECT`),
    'for ns in $(awk \'/^nameserver/{print $2}\' /etc/resolv.conf); do case "$ns" in *:*) ;; *) iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT; iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT;; esac; done'];
  for (const { cidr, port } of networks) {
    if (port) rules.push(`iptables -A OUTPUT -d ${cidr} -p tcp --dport ${port} -j ACCEPT`, `iptables -A OUTPUT -d ${cidr} -p udp --dport ${port} -j ACCEPT`, `iptables -A OUTPUT -d ${cidr} -p icmp -j ACCEPT`);
    else rules.push(`iptables -A OUTPUT -d ${cidr} -j ACCEPT`);
  }
  if (hostAddress && hostAll) rules.push(`iptables -A OUTPUT -d ${hostAddress} -j ACCEPT`);
  else if (hostAddress) for (const port of hostPorts) rules.push(`iptables -A OUTPUT -d ${hostAddress} -p tcp --dport ${port} -j ACCEPT`);
  rules.push('iptables -A OUTPUT -j REJECT', '(ip6tables -P OUTPUT DROP && ip6tables -A OUTPUT -o lo -j ACCEPT) 2>/dev/null || true', 'echo active > /run/zaalis-firewall');
  return rules.join('\n');
}

module.exports = { nftRules, cloudConfig, pentestInstallScript, containerFirewall, PENTEST_PACKAGES, SLIRP_HOST };
