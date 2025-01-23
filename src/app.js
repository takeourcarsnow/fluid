import * as THREE from 'three';
import Stats from 'stats.js';
import * as Matter from 'matter-js';

// Configuration
const CONFIG = {
    particles: {
        count: 1000,
        size: 0.2,
        color: 0x00ff00,
        physicsSize: 0.1,
        restitution: 0.7,
        friction: 0.1,
        density: 0.001,
        airFriction: 0.01
    },
    physics: {
        gravityScale: 0.001,
        viscosity: 0.01,
        surfaceTension: 0.05,
        iterations: 4
    },
    container: {
        width: 10,
        height: 10,
        depth: 10
    },
    debug: {
        enabled: true
    }
};

// Utility class for sensor data filtering
class KalmanFilter {
    constructor() {
        this.R = 0.01;
        this.Q = 3;
        this.A = 1;
        this.B = 0;
        this.C = 1;
        this.cov = NaN;
        this.x = NaN;
    }

    filter(measurement) {
        if (isNaN(this.x)) {
            this.x = measurement / this.C;
            this.cov = 1;
        } else {
            const predX = this.A * this.x + this.B;
            const predCov = this.A * this.A * this.cov + this.Q;
            const K = predCov * this.C / (this.C * predCov * this.C + this.R);
            this.x = predX + K * (measurement - this.C * predX);
            this.cov = predCov - K * this.C * predCov;
        }
        return this.x;
    }
}

// Debug logging utility
const DEBUG = {
    log: function(...args) {
        if (CONFIG.debug.enabled) {
            console.log('[Fluid Simulation]', ...args);
        }
    },
    error: function(...args) {
        console.error('[Fluid Simulation]', ...args);
    }
};

// Shader definitions
const Shaders = {
    particle: {
        vertex: `
            attribute float size;
            attribute vec3 color;
            varying vec3 vColor;
            uniform float time;

            void main() {
                vColor = color;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = size * (300.0 / -mvPosition.z);
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragment: `
            varying vec3 vColor;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float intensity = 1.0 - (r * 2.0);
                gl_FragColor = vec4(vColor * intensity, intensity);
            }
        `
    }
};

class FluidSimulation {
    constructor() {
        DEBUG.log('Initializing simulation...');
        
        this.clock = new THREE.Clock();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        
        this.setupRenderer();
        this.setupScene();
        this.setupPhysics();
        this.setupParticles();
        this.setupSensors();
        this.setupDebug();
        this.setupEventListeners();

        DEBUG.log('Simulation initialized');
    }

    setupRenderer() {
        DEBUG.log('Setting up renderer...');
        
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true
        });
        
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 1);
        
        document.body.appendChild(this.renderer.domElement);
    }

    setupScene() {
        DEBUG.log('Setting up scene...');
        
        this.camera.position.z = 15;

        const ambientLight = new THREE.AmbientLight(0x404040);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
        directionalLight.position.set(1, 1, 1);
        
        this.scene.add(ambientLight);
        this.scene.add(directionalLight);

        const containerGeometry = new THREE.BoxGeometry(
            CONFIG.container.width,
            CONFIG.container.height,
            CONFIG.container.depth
        );
        
        const containerMaterial = new THREE.MeshPhysicalMaterial({
            color: 0x156289,
            metalness: 0.9,
            roughness: 0.1,
            transparent: true,
            opacity: 0.2,
            side: THREE.BackSide
        });

        this.containerMesh = new THREE.Mesh(containerGeometry, containerMaterial);
        this.scene.add(this.containerMesh);
    }

    setupPhysics() {
        DEBUG.log('Setting up physics...');
        
        this.engine = Matter.Engine.create({
            constraintIterations: CONFIG.physics.iterations,
            positionIterations: 6,
            velocityIterations: 4
        });

        this.world = this.engine.world;
        this.world.gravity.scale = 0;

        const wallOptions = {
            isStatic: true,
            restitution: 0.7,
            friction: 0.1
        };

        this.walls = [
            Matter.Bodies.rectangle(0, CONFIG.container.height/2, CONFIG.container.width, 1, wallOptions),
            Matter.Bodies.rectangle(0, -CONFIG.container.height/2, CONFIG.container.width, 1, wallOptions),
            Matter.Bodies.rectangle(-CONFIG.container.width/2, 0, 1, CONFIG.container.height, wallOptions),
            Matter.Bodies.rectangle(CONFIG.container.width/2, 0, 1, CONFIG.container.height, wallOptions)
        ];

        Matter.World.add(this.world, this.walls);
    }

    setupParticles() {
        DEBUG.log('Setting up particles...');
        
        const particleGeometry = new THREE.BufferGeometry();
        const positions = new Float32Array(CONFIG.particles.count * 3);
        const colors = new Float32Array(CONFIG.particles.count * 3);
        const sizes = new Float32Array(CONFIG.particles.count);

        this.physicsParticles = [];

        for (let i = 0; i < CONFIG.particles.count; i++) {
            const x = (Math.random() - 0.5) * CONFIG.container.width * 0.8;
            const y = (Math.random() - 0.5) * CONFIG.container.height * 0.8;
            const z = (Math.random() - 0.5) * CONFIG.container.depth * 0.8;

            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = z;

            const hue = 0.3 + Math.random() * 0.1;
            const color = new THREE.Color().setHSL(hue, 1, 0.5);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;

            sizes[i] = Math.random() * 0.5 + 0.5;

            const particle = Matter.Bodies.circle(
                x, y,
                CONFIG.particles.physicsSize,
                {
                    restitution: CONFIG.particles.restitution,
                    friction: CONFIG.particles.friction,
                    density: CONFIG.particles.density,
                    frictionAir: CONFIG.particles.airFriction
                }
            );

            this.physicsParticles.push(particle);
            Matter.World.add(this.world, particle);
        }

        particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        particleGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        const particleMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 }
            },
            vertexShader: Shaders.particle.vertex,
            fragmentShader: Shaders.particle.fragment,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.particles = new THREE.Points(particleGeometry, particleMaterial);
        this.scene.add(this.particles);
    }

    setupSensors() {
        DEBUG.log('Setting up sensors...');
        
        this.filters = {
            accelerationX: new KalmanFilter(),
            accelerationY: new KalmanFilter(),
            accelerationZ: new KalmanFilter()
        };

        this.sensorData = {
            acceleration: { x: 0, y: 0, z: 0 },
            rotation: { alpha: 0, beta: 0, gamma: 0 }
        };
    }

    setupDebug() {
        if (CONFIG.debug.enabled) {
            this.stats = new Stats();
            document.body.appendChild(this.stats.dom);
            this.debugInfo = document.getElementById('debug-info');
        }
    }

    setupEventListeners() {
        DEBUG.log('Setting up event listeners...');
        
        window.addEventListener('resize', () => this.onResize());
        window.addEventListener('devicemotion', (e) => this.handleMotion(e));
        window.addEventListener('deviceorientation', (e) => this.handleOrientation(e));
        this.renderer.domElement.addEventListener('touchstart', (e) => this.handleTouch(e));
        this.renderer.domElement.addEventListener('touchmove', (e) => this.handleTouch(e));
    }

    handleMotion(event) {
        if (!event.accelerationIncludingGravity) return;

        this.sensorData.acceleration = {
            x: this.filters.accelerationX.filter(event.accelerationIncludingGravity.x || 0),
            y: this.filters.accelerationY.filter(event.accelerationIncludingGravity.y || 0),
            z: this.filters.accelerationZ.filter(event.accelerationIncludingGravity.z || 0)
        };
    }

    handleOrientation(event) {
        this.sensorData.rotation = {
            alpha: event.alpha || 0,
            beta: event.beta || 0,
            gamma: event.gamma || 0
        };

        if (this.containerMesh) {
            this.containerMesh.rotation.x = THREE.MathUtils.degToRad(this.sensorData.rotation.beta || 0);
            this.containerMesh.rotation.y = THREE.MathUtils.degToRad(this.sensorData.rotation.gamma || 0);
        }
    }

    handleTouch(event) {
        event.preventDefault();
        
        if (!event.touches[0]) return;

        const touch = event.touches[0];
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

        const raycaster = new THREE.Raycaster();
        const touchPosition = new THREE.Vector2(x, y);
        raycaster.setFromCamera(touchPosition, this.camera);

        const touchForce = 0.005;
        const touchRadius = 2;

        this.physicsParticles.forEach(particle => {
            const particlePosition = new THREE.Vector3(
                particle.position.x,
                particle.position.y,
                0
            );

            const distance = raycaster.ray.distanceToPoint(particlePosition);

            if (distance < touchRadius) {
                const force = (1 - distance / touchRadius) * touchForce;
                const forceVector = raycaster.ray.direction.multiplyScalar(force);

                Matter.Body.applyForce(particle, particle.position, {
                    x: forceVector.x,
                    y: forceVector.y
                });
            }
        });
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    updateParticles() {
        const positions = this.particles.geometry.attributes.position.array;
        const colors = this.particles.geometry.attributes.color.array;
        const sizes = this.particles.geometry.attributes.size.array;

        this.physicsParticles.forEach((particle, i) => {
            positions[i * 3] = particle.position.x;
            positions[i * 3 + 1] = particle.position.y;
            positions[i * 3 + 2] = 0;

            const speed = Math.sqrt(
                particle.velocity.x * particle.velocity.x +
                particle.velocity.y * particle.velocity.y
            );
            
            const hue = 0.3 + (speed * 0.2);
            const color = new THREE.Color().setHSL(hue, 1, 0.5);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;

            sizes[i] = Math.max(0.5, 1 - Math.abs(positions[i * 3 + 2]) * 0.1);
        });

        this.particles.geometry.attributes.position.needsUpdate = true;
        this.particles.geometry.attributes.color.needsUpdate = true;
        this.particles.geometry.attributes.size.needsUpdate = true;
    }

    updatePhysics(deltaTime) {
        const gravity = {
            x: this.sensorData.acceleration.x * CONFIG.physics.gravityScale,
            y: -this.sensorData.acceleration.y * CONFIG.physics.gravityScale
        };

        this.world.gravity = gravity;

        this.physicsParticles.forEach(particle => {
            Matter.Body.setVelocity(particle, {
                x: particle.velocity.x * (1 - CONFIG.physics.viscosity),
                y: particle.velocity.y * (1 - CONFIG.physics.viscosity)
            });
        });

        Matter.Engine.update(this.engine, deltaTime * 1000);
    }

    updateDebugInfo() {
        if (this.debugInfo) {
            this.debugInfo.textContent = `
                FPS: ${Math.round(1000 / this.stats.delta)}
                Particles: ${CONFIG.particles.count}
                Acceleration: 
                    x: ${this.sensorData.acceleration.x.toFixed(3)}
                    y: ${this.sensorData.acceleration.y.toFixed(3)}
                    z: ${this.sensorData.acceleration.z.toFixed(3)}
                Rotation: 
                    β: ${this.sensorData.rotation.beta.toFixed(1)}°
                    γ: ${this.sensorData.rotation.gamma.toFixed(1)}°
            `;
        }
    }

    update() {
        if (!this.isRunning) return;

        if (this.stats) this.stats.begin();

        const deltaTime = this.clock.getDelta();
        const elapsedTime = this.clock.elapsedTime;

        // Update physics
        this.updatePhysics(deltaTime);

        // Update particles
        this.updateParticles();

        // Update shader uniforms
        if (this.particles && this.particles.material.uniforms) {
            this.particles.material.uniforms.time.value = elapsedTime;
        }

        // Render
        this.renderer.render(this.scene, this.camera);

        // Update debug info
        if (this.stats && this.frameCount % 10 === 0) {
            this.updateDebugInfo();
        }

        this.frameCount++;

        if (this.stats) this.stats.end();

        requestAnimationFrame(() => this.update());
    }

    start() {
        DEBUG.log('Starting simulation...');
        this.isRunning = true;
        this.frameCount = 0;
        this.update();
    }

    pause() {
        this.isRunning = false;
    }

    resume() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.update();
        }
    }

    dispose() {
        DEBUG.log('Disposing simulation...');
        
        this.isRunning = false;
        
        // Remove event listeners
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('devicemotion', this.handleMotion);
        window.removeEventListener('deviceorientation', this.handleOrientation);
        
        // Dispose Three.js resources
        this.scene.traverse(object => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (object.material.map) object.material.map.dispose();
                object.material.dispose();
            }
        });
        
        this.renderer.dispose();
        
        // Clean up physics
        Matter.World.clear(this.world);
        Matter.Engine.clear(this.engine);
        
        // Remove stats if exists
        if (this.stats && this.stats.dom.parentElement) {
            this.stats.dom.parentElement.removeChild(this.stats.dom);
        }
    }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    DEBUG.log('Application initializing...');
    
    const startButton = document.getElementById('start-button');
    let simulation = null;

    const showError = (message) => {
        const errorElement = document.getElementById('error-message');
        errorElement.textContent = message;
        errorElement.style.display = 'block';
        setTimeout(() => {
            errorElement.style.display = 'none';
        }, 5000);
    };

    const checkWebGLSupport = () => {
        try {
            const canvas = document.createElement('canvas');
            return !!(window.WebGLRenderingContext && 
                (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
        } catch (e) {
            return false;
        }
    };

    startButton.addEventListener('click', async () => {
        try {
            // Check WebGL support
            if (!checkWebGLSupport()) {
                throw new Error('WebGL is not supported in your browser');
            }

            // Request device motion/orientation permissions (iOS)
            if (typeof DeviceOrientationEvent !== 'undefined' && 
                typeof DeviceOrientationEvent.requestPermission === 'function') {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission !== 'granted') {
                    throw new Error('Permission to access device sensors was denied');
                }
            }

            // Hide loading screen
            document.getElementById('loading-screen').style.display = 'none';

            // Create and start simulation
            DEBUG.log('Creating simulation instance...');
            simulation = new FluidSimulation();
            simulation.start();

        } catch (error) {
            DEBUG.error('Failed to start simulation:', error);
            showError(error.message);
            
            // Show loading screen again
            document.getElementById('loading-screen').style.display = 'flex';
        }
    });

    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
        if (!simulation) return;
        
        if (document.hidden) {
            simulation.pause();
        } else {
            simulation.resume();
        }
    });

    // Handle errors
    window.addEventListener('error', (event) => {
        DEBUG.error('Global error:', event.error);
        showError('An error occurred: ' + event.error.message);
    });

    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        DEBUG.error('Unhandled promise rejection:', event.reason);
        showError('An error occurred: ' + event.reason);
    });
});

// Export for debugging
if (CONFIG.debug.enabled) {
    window.__DEBUG__ = DEBUG;
}
