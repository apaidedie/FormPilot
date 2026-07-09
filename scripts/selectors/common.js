/**
 * FormPilot - Common Selectors
 * 通用表单字段选择器
 */

window.FormPilotSelectors = window.FormPilotSelectors || {};

window.FormPilotSelectors.common = {
    firstName: [
        // XServer VPS 特殊字段
        'input[name="name2"]',
        // 标准属性匹配
        'input[name*="first" i]',
        'input[name*="fname" i]',
        'input[name*="given" i]',
        'input[id*="first" i]',
        'input[id*="fname" i]',
        // placeholder 匹配
        'input[placeholder*="first" i]',
        'input[placeholder*="given" i]',
        'input[placeholder*="名" i]:not([placeholder*="姓" i])',
        'input[placeholder="太郎"]',
        // autocomplete 标准
        'input[autocomplete="given-name"]',
        'input[autocomplete="first-name"]',
        // aria-label 匹配
        'input[aria-label*="first" i]',
        'input[aria-label*="given" i]',
        // data 属性匹配
        'input[data-field*="first" i]',
        'input[data-type*="first" i]'
    ],
    lastName: [
        // XServer VPS 特殊字段
        'input[name="name1"]',
        'input[name*="last" i]',
        'input[name*="lname" i]',
        'input[name*="surname" i]',
        'input[name*="family" i]',
        'input[id*="last" i]',
        'input[id*="lname" i]',
        'input[id*="surname" i]',
        'input[placeholder*="last" i]',
        'input[placeholder*="surname" i]',
        'input[placeholder*="family" i]',
        'input[placeholder*="姓" i]:not([placeholder*="名" i])',
        'input[placeholder="山田"]',
        'input[autocomplete="family-name"]',
        'input[autocomplete="last-name"]',
        'input[aria-label*="last" i]',
        'input[aria-label*="surname" i]',
        'input[data-field*="last" i]'
    ],
    gender: [
        'select[name*="gender" i]',
        'select[id*="gender" i]',
        'select[name*="sex" i]',
        'select[id*="sex" i]',
        'input[name*="gender" i]',
        'input[id*="gender" i]',
        'input[aria-label*="gender" i]',
        'select[aria-label*="gender" i]'
    ],
    birthday: [
        'input[type="date"]',
        'input[name*="birth" i]',
        'input[name*="dob" i]',
        'input[name*="bday" i]',
        'input[id*="birth" i]',
        'input[id*="dob" i]',
        'input[id*="bday" i]',
        'input[placeholder*="birth" i]',
        'input[placeholder*="生日" i]',
        'input[placeholder*="出生" i]',
        'input[autocomplete="bday"]',
        'input[autocomplete="birthday"]',
        'input[aria-label*="birth" i]',
        'input[data-field*="birth" i]'
    ],
    username: [
        'input[name*="user" i]:not([type="password"])',
        'input[name*="login" i]:not([type="password"])',
        'input[name*="account" i]:not([type="password"])',
        'input[name*="nickname" i]',
        'input[name*="nick" i]',
        'input[id*="user" i]:not([type="password"])',
        'input[id*="nickname" i]',
        'input[placeholder*="user" i]',
        'input[placeholder*="用户" i]',
        'input[placeholder*="昵称" i]',
        'input[autocomplete="username"]',
        'input[aria-label*="user" i]',
        'input[data-field*="user" i]'
    ],
    email: [
        // XServer 特殊字段
        'input[name="mailaddress"]',
        'input[type="email"]',
        'input[name*="email" i]',
        'input[name*="mail" i]',
        'input[name*="e-mail" i]',
        'input[id*="email" i]',
        'input[id*="mail" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="邮箱" i]',
        'input[placeholder*="电子邮件" i]',
        'input[autocomplete="email"]',
        'input[aria-label*="email" i]',
        'input[aria-label*="mail" i]',
        'input[data-field*="email" i]'
    ],
    password: [
        'input[type="password"]',
        'input[name*="pass" i]',
        'input[name*="pwd" i]',
        'input[name*="secret" i]',
        'input[id*="pass" i]',
        'input[id*="pwd" i]',
        'input[placeholder*="password" i]',
        'input[placeholder*="密码" i]',
        'input[autocomplete="new-password"]',
        'input[autocomplete="current-password"]',
        'input[aria-label*="password" i]'
    ],
    phone: [
        'input[type="tel"]',
        'input[name*="phone" i]',
        'input[name*="mobile" i]',
        'input[name*="tel" i]',
        'input[name*="cell" i]',
        'input[name*="contact" i]',
        'input[id*="phone" i]',
        'input[id*="mobile" i]',
        'input[id*="tel" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="mobile" i]',
        'input[placeholder*="电话" i]',
        'input[placeholder*="手机" i]',
        'input[autocomplete="tel"]',
        'input[autocomplete="tel-national"]',
        'input[aria-label*="phone" i]',
        'input[aria-label*="mobile" i]',
        'input[data-field*="phone" i]'
    ],
    address: [
        // XServer 特殊字段 - 町域・番地
        'input[name="address2"]',
        // 排除邮箱字段
        'input[name*="address" i]:not([type="email"]):not([name*="mail" i])',
        'input[name*="street" i]',
        'input[name*="addr" i]',
        'input[id*="address" i]',
        'input[id*="street" i]',
        'input[placeholder*="address" i]',
        'input[placeholder*="street" i]',
        'input[placeholder*="地址" i]',
        'input[placeholder*="街道" i]',
        'input[autocomplete="street-address"]',
        'input[autocomplete="address-line1"]',
        'input[autocomplete="address-line2"]',
        'input[aria-label*="address" i]',
        'input[aria-label*="street" i]',
        'textarea[name*="address" i]',
        'textarea[id*="address" i]',
        'textarea[placeholder*="address" i]'
    ],
    city: [
        'input[name*="city" i]',
        'input[name*="town" i]',
        'input[name*="locality" i]',
        'input[id*="city" i]',
        'input[id*="town" i]',
        'input[placeholder*="city" i]',
        'input[placeholder*="城市" i]',
        'input[autocomplete="address-level2"]',
        'input[aria-label*="city" i]',
        'select[name*="city" i]',
        'select[id*="city" i]'
    ],
    zipCode: [
        'input[name*="zip" i]',
        'input[name*="postal" i]',
        'input[name*="postcode" i]',
        'input[name*="post_code" i]',
        'input[id*="zip" i]',
        'input[id*="postal" i]',
        'input[placeholder*="zip" i]',
        'input[placeholder*="postal" i]',
        'input[placeholder*="邮编" i]',
        'input[placeholder*="邮政编码" i]',
        'input[autocomplete="postal-code"]',
        'input[aria-label*="zip" i]',
        'input[aria-label*="postal" i]',
        'input[data-field*="zip" i]'
    ],
    state: [
        'input[name*="state" i]',
        'input[name*="province" i]',
        'input[name*="region" i]',
        'input[name*="prefecture" i]',
        'input[id*="state" i]',
        'input[id*="province" i]',
        'input[id*="region" i]',
        'input[placeholder*="state" i]',
        'input[placeholder*="province" i]',
        'input[placeholder*="省" i]',
        'input[placeholder*="州" i]',
        'select[name*="state" i]',
        'select[name*="province" i]',
        'select[name*="region" i]',
        'select[id*="state" i]',
        'select[id*="province" i]',
        'input[autocomplete="address-level1"]',
        'input[aria-label*="state" i]',
        'input[aria-label*="province" i]'
    ],
    country: [
        'input[name*="country" i]',
        'input[name*="nation" i]',
        'input[id*="country" i]',
        'input[placeholder*="country" i]',
        'input[placeholder*="国家" i]',
        'select[name*="country" i]',
        'select[id*="country" i]',
        'input[autocomplete="country-name"]',
        'input[autocomplete="country"]',
        'input[aria-label*="country" i]',
        'select[aria-label*="country" i]'
    ],
    shippingAddress: [
        'input[autocomplete="shipping street-address"]',
        'input[autocomplete="shipping address-line1"]',
        'textarea[autocomplete="shipping street-address"]',
        'input[name*="shipping" i][name*="address" i]',
        'input[id*="shipping" i][id*="address" i]',
        'textarea[name*="shipping" i][name*="address" i]',
        'input[name*="ship" i][name*="addr" i]',
        'input[id*="ship" i][id*="addr" i]'
    ],
    shippingCity: [
        'input[autocomplete="shipping address-level2"]',
        'input[name*="shipping" i][name*="city" i]',
        'input[id*="shipping" i][id*="city" i]',
        'input[name*="ship" i][name*="city" i]',
        'select[name*="shipping" i][name*="city" i]'
    ],
    shippingState: [
        'input[autocomplete="shipping address-level1"]',
        'select[autocomplete="shipping address-level1"]',
        'input[name*="shipping" i][name*="state" i]',
        'input[name*="shipping" i][name*="province" i]',
        'select[name*="shipping" i][name*="state" i]',
        'input[id*="shipping" i][id*="state" i]',
        'input[name*="ship" i][name*="state" i]'
    ],
    shippingZipCode: [
        'input[autocomplete="shipping postal-code"]',
        'input[name*="shipping" i][name*="zip" i]',
        'input[name*="shipping" i][name*="postal" i]',
        'input[id*="shipping" i][id*="zip" i]',
        'input[name*="ship" i][name*="zip" i]'
    ],
    shippingCountry: [
        'input[autocomplete="shipping country-name"]',
        'select[autocomplete="shipping country-name"]',
        'input[name*="shipping" i][name*="country" i]',
        'select[name*="shipping" i][name*="country" i]',
        'input[id*="shipping" i][id*="country" i]',
        'input[name*="ship" i][name*="country" i]'
    ],
    billingAddress: [
        'input[autocomplete="billing street-address"]',
        'input[autocomplete="billing address-line1"]',
        'textarea[autocomplete="billing street-address"]',
        'input[name*="billing" i][name*="address" i]',
        'input[id*="billing" i][id*="address" i]',
        'textarea[name*="billing" i][name*="address" i]',
        'input[name*="bill" i][name*="addr" i]',
        'input[id*="bill" i][id*="addr" i]'
    ],
    billingCity: [
        'input[autocomplete="billing address-level2"]',
        'input[name*="billing" i][name*="city" i]',
        'input[id*="billing" i][id*="city" i]',
        'input[name*="bill" i][name*="city" i]',
        'select[name*="billing" i][name*="city" i]'
    ],
    billingState: [
        'input[autocomplete="billing address-level1"]',
        'select[autocomplete="billing address-level1"]',
        'input[name*="billing" i][name*="state" i]',
        'input[name*="billing" i][name*="province" i]',
        'select[name*="billing" i][name*="state" i]',
        'input[id*="billing" i][id*="state" i]',
        'input[name*="bill" i][name*="state" i]'
    ],
    billingZipCode: [
        'input[autocomplete="billing postal-code"]',
        'input[name*="billing" i][name*="zip" i]',
        'input[name*="billing" i][name*="postal" i]',
        'input[id*="billing" i][id*="zip" i]',
        'input[name*="bill" i][name*="zip" i]'
    ],
    billingCountry: [
        'input[autocomplete="billing country-name"]',
        'select[autocomplete="billing country-name"]',
        'input[name*="billing" i][name*="country" i]',
        'select[name*="billing" i][name*="country" i]',
        'input[id*="billing" i][id*="country" i]',
        'input[name*="bill" i][name*="country" i]'
    ],
    cardIssuer: [
        'input[name*="issuer" i]',
        'input[id*="issuer" i]',
        'input[name*="bank" i][name*="card" i]',
        'input[id*="bank" i][id*="card" i]'
    ],
    cardNetwork: [
        'input[name*="card" i][name*="network" i]',
        'input[id*="card" i][id*="network" i]',
        'select[name*="card" i][name*="network" i]',
        'select[id*="card" i][id*="network" i]',
        'select[name*="card" i][name*="type" i]',
        'select[id*="card" i][id*="type" i]'
    ],
    cardLast4: [
        'input[name*="last4" i]',
        'input[id*="last4" i]',
        'input[name*="card" i][name*="last" i]',
        'input[id*="card" i][id*="last" i]'
    ],
    cardExpiry: [
        'input[name*="expiry" i]',
        'input[name*="expiration" i]',
        'input[id*="expiry" i]',
        'input[id*="expiration" i]'
    ],
    billingNote: [
        'textarea[name*="billing" i][name*="note" i]',
        'textarea[id*="billing" i][id*="note" i]',
        'input[name*="billing" i][name*="note" i]'
    ]
};

window.FormPilotSelectors.commonLabels = {
    firstName: ['first name', 'given name', 'fname', '名', '名字'],
    lastName: ['last name', 'family name', 'surname', 'lname', '姓', '姓氏'],
    email: ['email', 'e-mail', 'mail', '邮箱', '电子邮箱'],
    phone: ['phone', 'mobile', 'cell', 'tel', '电话', '手机', '联系方式'],
    address: ['address', 'street', 'addr', '地址', '街道'],
    city: ['city', 'town', '城市', '市'],
    state: ['state', 'province', 'region', 'county', '省', '州'],
    zipCode: ['zip', 'postal', 'postcode', '邮编', '邮政编码'],
    country: ['country', 'nation', '国家'],
    username: ['username', 'user', 'login', 'account', '用户名', '账号'],
    password: ['password', 'pass', 'pwd', '密码', '口令'],
    birthday: ['birthday', 'birth', 'dob', '生日', '出生日期'],
    gender: ['gender', 'sex', '性别'],
    shippingAddress: ['shipping address', 'delivery address', 'ship to', '收货地址', '配送地址'],
    shippingCity: ['shipping city', 'delivery city', '收货城市', '配送城市'],
    shippingState: ['shipping state', 'shipping province', '收货州', '收货省'],
    shippingZipCode: ['shipping zip', 'shipping postal', '收货邮编'],
    shippingCountry: ['shipping country', '收货国家'],
    billingAddress: ['billing address', '账单地址'],
    billingCity: ['billing city', '账单城市'],
    billingState: ['billing state', 'billing province', '账单州', '账单省'],
    billingZipCode: ['billing zip', 'billing postal', '账单邮编'],
    billingCountry: ['billing country', '账单国家'],
    cardIssuer: ['card issuer', 'issuing bank', '发卡行'],
    cardNetwork: ['card network', 'card type', '卡组织', '卡类型'],
    cardLast4: ['last 4', 'last four', '尾号'],
    cardExpiry: ['expiry', 'expiration', '有效期'],
    billingNote: ['billing note', '账单备注']
};

window.FormPilotSelectors.fullNames = [
    'input[name*="fullname" i]',
    'input[name*="full_name" i]',
    'input[name*="name" i]:not([name*="user" i]):not([name*="first" i]):not([name*="last" i])',
    'input[id*="fullname" i]',
    'input[placeholder*="full name" i]',
    'input[placeholder*="your name" i]',
    'input[placeholder*="姓名" i]',
    'input[autocomplete="name"]',
    'input[aria-label*="full name" i]',
    'input[aria-label*="your name" i]'
];
