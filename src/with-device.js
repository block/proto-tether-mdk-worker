'use strict'

const { getClient } = require('./client')

module.exports = handler => async (params = {}) => handler(await getClient(), params)
